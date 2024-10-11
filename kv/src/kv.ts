/*
 * Copyright 2021-2024 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  compare,
  Empty,
  ErrorCode,
  Feature,
  headers,
  millis,
  nanos,
  nuid,
  parseSemVer,
  QueuedIteratorImpl,
} from "@nats-io/nats-core/internal";

import type {
  MsgHdrs,
  NatsConnection,
  NatsConnectionImpl,
  NatsError,
  Payload,
  QueuedIterator,
} from "@nats-io/nats-core/internal";

import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  JsHeaders,
  ListerImpl,
  PubHeaders,
  RetentionPolicy,
  StorageType,
  StoreCompression,
  toJetStreamClient,
} from "@nats-io/jetstream/internal";

import type {
  ConsumerConfig,
  DirectStreamAPI,
  JetStreamClient,
  JetStreamClientImpl,
  JetStreamManager,
  JetStreamPublishOptions,
  JsMsg,
  Lister,
  ListerFieldFilter,
  MsgRequest,
  Placement,
  PurgeOpts,
  PurgeResponse,
  Republish,
  StoredMsg,
  StreamConfig,
  StreamInfo,
  StreamListResponse,
  StreamSource,
} from "@nats-io/jetstream/internal";

import type {
  KV,
  KvCodec,
  KvCodecs,
  KvDeleteOptions,
  KvEntry,
  KvOptions,
  KvPutOptions,
  KvRemove,
  KvStatus,
  KvWatchEntry,
  KvWatchOptions,
} from "./types.ts";

import { kvPrefix, KvWatchInclude } from "./types.ts";

export function Base64KeyCodec(): KvCodec<string> {
  return {
    encode(key: string): string {
      return btoa(key);
    },
    decode(bkey: string): string {
      return atob(bkey);
    },
  };
}

export function NoopKvCodecs(): KvCodecs {
  return {
    key: {
      encode(k: string): string {
        return k;
      },
      decode(k: string): string {
        return k;
      },
    },
    value: {
      encode(v: Uint8Array): Uint8Array {
        return v;
      },
      decode(v: Uint8Array): Uint8Array {
        return v;
      },
    },
  };
}

export function defaultBucketOpts(): Partial<KvOptions> {
  return {
    replicas: 1,
    history: 1,
    timeout: 2000,
    max_bytes: -1,
    maxValueSize: -1,
    codec: NoopKvCodecs(),
    storage: StorageType.File,
  };
}

type OperationType = "PUT" | "DEL" | "PURGE";

export const kvOperationHdr = "KV-Operation";
const kvSubjectPrefix = "$KV";

const validKeyRe = /^[-/=.\w]+$/;
const validSearchKey = /^[-/=.>*\w]+$/;
const validBucketRe = /^[-\w]+$/;

// this exported for tests
export function validateKey(k: string) {
  if (k.startsWith(".") || k.endsWith(".") || !validKeyRe.test(k)) {
    throw new Error(`invalid key: ${k}`);
  }
}

export function validateSearchKey(k: string) {
  if (k.startsWith(".") || k.endsWith(".") || !validSearchKey.test(k)) {
    throw new Error(`invalid key: ${k}`);
  }
}

export function hasWildcards(k: string): boolean {
  if (k.startsWith(".") || k.endsWith(".")) {
    throw new Error(`invalid key: ${k}`);
  }
  const chunks = k.split(".");

  let hasWildcards = false;
  for (let i = 0; i < chunks.length; i++) {
    switch (chunks[i]) {
      case "*":
        hasWildcards = true;
        break;
      case ">":
        if (i !== chunks.length - 1) {
          throw new Error(`invalid key: ${k}`);
        }
        hasWildcards = true;
        break;
      default:
        // continue
    }
  }
  return hasWildcards;
}

// this exported for tests
export function validateBucket(name: string) {
  if (!validBucketRe.test(name)) {
    throw new Error(`invalid bucket name: ${name}`);
  }
}

/**
 * The entry point to creating new KV instances.
 */
export class Kvm {
  js: JetStreamClientImpl;

  /**
   * Creates an instance of the Kv that allows you to create and access KV stores.
   * Note that if the argument is a NatsConnection, default JetStream Options are
   * used. If you want to set some options, please provide a JetStreamClient instead.
   * @param nc
   */
  constructor(nc: JetStreamClient | NatsConnection) {
    this.js = toJetStreamClient(nc) as JetStreamClientImpl;
  }

  /**
   * Creates and opens the specified KV. If the KV already exists, it opens the existing KV.
   * @param name
   * @param opts
   */
  create(name: string, opts: Partial<KvOptions> = {}): Promise<KV> {
    return this.#maybeCreate(name, opts);
  }

  /**
   * Open to the specified KV. If the KV doesn't exist, this API will fail.
   * @param name
   * @param opts
   */
  open(name: string, opts: Partial<KvOptions> = {}): Promise<KV> {
    opts.bindOnly = true;
    return this.#maybeCreate(name, opts);
  }

  #maybeCreate(name: string, opts: Partial<KvOptions> = {}): Promise<KV> {
    const { ok, min } = this.js.nc.features.get(Feature.JS_KV);
    if (!ok) {
      return Promise.reject(
        new Error(`kv is only supported on servers ${min} or better`),
      );
    }
    if (opts.bindOnly) {
      return Bucket.bind(this.js, name, opts);
    }

    return Bucket.create(this.js, name, opts);
  }

  /**
   * Lists all available KVs
   */
  list(): Lister<KvStatus> {
    const filter: ListerFieldFilter<KvStatus> = (
      v: unknown,
    ): KvStatus[] => {
      const slr = v as StreamListResponse;
      const kvStreams = slr.streams.filter((v) => {
        return v.config.name.startsWith(kvPrefix);
      });
      kvStreams.forEach((si) => {
        si.config.sealed = si.config.sealed || false;
        si.config.deny_delete = si.config.deny_delete || false;
        si.config.deny_purge = si.config.deny_purge || false;
        si.config.allow_rollup_hdrs = si.config.allow_rollup_hdrs || false;
      });
      let cluster = "";
      if (kvStreams.length) {
        cluster = this.js.nc.info?.cluster ?? "";
      }
      return kvStreams.map((si) => {
        return new KvStatusImpl(si, cluster);
      });
    };
    const subj = `${this.js.prefix}.STREAM.LIST`;
    return new ListerImpl<KvStatus>(subj, filter, this.js);
  }
}

export class Bucket implements KV, KvRemove {
  js: JetStreamClient;
  jsm: JetStreamManager;
  stream!: string;
  bucket: string;
  direct!: boolean;
  codec!: KvCodecs;
  prefix: string;
  editPrefix: string;
  useJsPrefix: boolean;
  _prefixLen: number;

  constructor(bucket: string, js: JetStreamClient, jsm: JetStreamManager) {
    validateBucket(bucket);
    this.js = js;
    this.jsm = jsm;
    this.bucket = bucket;
    this.prefix = kvSubjectPrefix;
    this.editPrefix = "";
    this.useJsPrefix = false;
    this._prefixLen = 0;
  }

  static async create(
    js: JetStreamClient,
    name: string,
    opts: Partial<KvOptions> = {},
  ): Promise<KV> {
    validateBucket(name);
    const jsm = await js.jetstreamManager();
    const bucket = new Bucket(name, js, jsm);
    await bucket.init(opts);
    return bucket;
  }

  static async bind(
    js: JetStreamClient,
    name: string,
    opts: Partial<KvOptions> = {},
  ): Promise<KV> {
    const jsm = await js.jetstreamManager();
    const info = {
      config: {
        allow_direct: opts.allow_direct,
      },
    } as StreamInfo;
    validateBucket(name);
    const bucket = new Bucket(name, js, jsm);
    info.config.name = opts.streamName ?? bucket.bucketName();
    Object.assign(bucket, info);
    bucket.stream = info.config.name;
    bucket.codec = opts.codec || NoopKvCodecs();
    bucket.direct = info.config.allow_direct ?? false;
    bucket.initializePrefixes(info);

    return bucket;
  }

  async init(opts: Partial<KvOptions> = {}): Promise<void> {
    const bo = Object.assign(defaultBucketOpts(), opts) as KvOptions;
    this.codec = bo.codec;
    const sc = {} as StreamConfig;
    this.stream = sc.name = opts.streamName ?? this.bucketName();
    sc.retention = RetentionPolicy.Limits;
    sc.max_msgs_per_subject = bo.history;
    if (bo.maxBucketSize) {
      bo.max_bytes = bo.maxBucketSize;
    }
    if (bo.max_bytes) {
      sc.max_bytes = bo.max_bytes;
    }
    sc.max_msg_size = bo.maxValueSize;
    sc.storage = bo.storage;
    const location = opts.placementCluster ?? "";
    if (location) {
      opts.placement = {} as Placement;
      opts.placement.cluster = location;
      opts.placement.tags = [];
    }
    if (opts.placement) {
      sc.placement = opts.placement;
    }
    if (opts.republish) {
      sc.republish = opts.republish;
    }
    if (opts.description) {
      sc.description = opts.description;
    }
    if (opts.mirror) {
      const mirror = Object.assign({}, opts.mirror);
      if (!mirror.name.startsWith(kvPrefix)) {
        mirror.name = `${kvPrefix}${mirror.name}`;
      }
      sc.mirror = mirror;
      sc.mirror_direct = true;
    } else if (opts.sources) {
      const sources = opts.sources.map((s) => {
        const c = Object.assign({}, s) as StreamSource;
        const srcBucketName = c.name.startsWith(kvPrefix)
          ? c.name.substring(kvPrefix.length)
          : c.name;
        if (!c.name.startsWith(kvPrefix)) {
          c.name = `${kvPrefix}${c.name}`;
        }
        if (!s.external && srcBucketName !== this.bucket) {
          c.subject_transforms = [
            { src: `$KV.${srcBucketName}.>`, dest: `$KV.${this.bucket}.>` },
          ];
        }
        return c;
      });
      sc.sources = sources as unknown[] as StreamSource[];
      sc.subjects = [this.subjectForBucket()];
    } else {
      sc.subjects = [this.subjectForBucket()];
    }
    if (opts.metadata) {
      sc.metadata = opts.metadata;
    }
    if (typeof opts.compression === "boolean") {
      sc.compression = opts.compression
        ? StoreCompression.S2
        : StoreCompression.None;
    }

    const nci = (this.js as unknown as { nc: NatsConnectionImpl }).nc;
    const have = nci.getServerVersion();
    const discardNew = have ? compare(have, parseSemVer("2.7.2")) >= 0 : false;
    sc.discard = discardNew ? DiscardPolicy.New : DiscardPolicy.Old;

    const { ok: direct, min } = nci.features.get(
      Feature.JS_ALLOW_DIRECT,
    );
    if (!direct && opts.allow_direct === true) {
      const v = have
        ? `${have!.major}.${have!.minor}.${have!.micro}`
        : "unknown";
      return Promise.reject(
        new Error(
          `allow_direct is not available on server version ${v} - requires ${min}`,
        ),
      );
    }
    // if we are given allow_direct we use it, otherwise what
    // the server supports - in creation this will always rule,
    // but allows the client to opt-in even if it is already
    // available on the stream
    opts.allow_direct = typeof opts.allow_direct === "boolean"
      ? opts.allow_direct
      : direct;
    sc.allow_direct = opts.allow_direct;
    this.direct = sc.allow_direct;

    sc.num_replicas = bo.replicas;
    if (bo.ttl) {
      sc.max_age = nanos(bo.ttl);
    }
    sc.allow_rollup_hdrs = true;

    let info: StreamInfo;
    try {
      info = await this.jsm.streams.info(sc.name);
      if (!info.config.allow_direct && this.direct === true) {
        this.direct = false;
      }
    } catch (err) {
      if ((err as Error).message === "stream not found") {
        info = await this.jsm.streams.add(sc);
      } else {
        throw err;
      }
    }
    this.initializePrefixes(info);
  }

  initializePrefixes(info: StreamInfo) {
    this._prefixLen = 0;
    this.prefix = `$KV.${this.bucket}`;
    this.useJsPrefix = this.js.apiPrefix !== "$JS.API";
    const { mirror } = info.config;
    if (mirror) {
      let n = mirror.name;
      if (n.startsWith(kvPrefix)) {
        n = n.substring(kvPrefix.length);
      }
      if (mirror.external && mirror.external.api !== "") {
        const mb = mirror.name.substring(kvPrefix.length);
        this.useJsPrefix = false;
        this.prefix = `$KV.${mb}`;
        this.editPrefix = `${mirror.external.api}.$KV.${n}`;
      } else {
        this.editPrefix = this.prefix;
      }
    }
  }

  bucketName(): string {
    return this.stream ?? `${kvPrefix}${this.bucket}`;
  }

  subjectForBucket(): string {
    return `${this.prefix}.${this.bucket}.>`;
  }

  subjectForKey(k: string, edit = false): string {
    const builder: string[] = [];
    if (edit) {
      if (this.useJsPrefix) {
        builder.push(this.js.apiPrefix);
      }
      if (this.editPrefix !== "") {
        builder.push(this.editPrefix);
      } else {
        builder.push(this.prefix);
      }
    } else {
      if (this.prefix) {
        builder.push(this.prefix);
      }
    }
    builder.push(k);
    return builder.join(".");
  }

  fullKeyName(k: string): string {
    if (this.prefix !== "") {
      return `${this.prefix}.${k}`;
    }
    return `${kvSubjectPrefix}.${this.bucket}.${k}`;
  }

  get prefixLen(): number {
    if (this._prefixLen === 0) {
      this._prefixLen = this.prefix.length + 1;
    }
    return this._prefixLen;
  }

  encodeKey(key: string): string {
    const chunks: string[] = [];
    for (const t of key.split(".")) {
      switch (t) {
        case ">":
        case "*":
          chunks.push(t);
          break;
        default:
          chunks.push(this.codec.key.encode(t));
          break;
      }
    }
    return chunks.join(".");
  }

  decodeKey(ekey: string): string {
    const chunks: string[] = [];
    for (const t of ekey.split(".")) {
      switch (t) {
        case ">":
        case "*":
          chunks.push(t);
          break;
        default:
          chunks.push(this.codec.key.decode(t));
          break;
      }
    }
    return chunks.join(".");
  }

  validateKey = validateKey;

  validateSearchKey = validateSearchKey;

  hasWildcards = hasWildcards;

  close(): Promise<void> {
    return Promise.resolve();
  }

  dataLen(data: Uint8Array, h?: MsgHdrs): number {
    const slen = h ? h.get(JsHeaders.MessageSizeHdr) || "" : "";
    if (slen !== "") {
      return parseInt(slen, 10);
    }
    return data.length;
  }

  smToEntry(sm: StoredMsg): KvEntry {
    return new KvStoredEntryImpl(this.bucket, this.prefixLen, sm);
  }

  jmToWatchEntry(jm: JsMsg, isUpdate = false): KvWatchEntry {
    const key = this.decodeKey(jm.subject.substring(this.prefixLen));
    return new KvJsMsgEntryImpl(this.bucket, key, jm, isUpdate);
  }

  async create(k: string, data: Payload): Promise<number> {
    let firstErr;
    try {
      const n = await this.put(k, data, { previousSeq: 0 });
      return Promise.resolve(n);
    } catch (err) {
      firstErr = err;
      if ((err as NatsError)?.api_error?.err_code !== 10071) {
        return Promise.reject(err);
      }
    }
    let rev = 0;
    try {
      const e = await this.get(k);
      if (e?.operation === "DEL" || e?.operation === "PURGE") {
        rev = e !== null ? e.revision : 0;
        return this.update(k, data, rev);
      } else {
        return Promise.reject(firstErr);
      }
    } catch (err) {
      return Promise.reject(err);
    }
  }

  update(k: string, data: Payload, version: number): Promise<number> {
    if (version <= 0) {
      throw new Error("version must be greater than 0");
    }
    return this.put(k, data, { previousSeq: version });
  }

  async put(
    k: string,
    data: Payload,
    opts: Partial<KvPutOptions> = {},
  ): Promise<number> {
    const ek = this.encodeKey(k);
    this.validateKey(ek);

    const o = {} as JetStreamPublishOptions;
    if (opts.previousSeq !== undefined) {
      const h = headers();
      o.headers = h;
      h.set(PubHeaders.ExpectedLastSubjectSequenceHdr, `${opts.previousSeq}`);
    }
    try {
      const pa = await this.js.publish(this.subjectForKey(ek, true), data, o);
      return pa.seq;
    } catch (err) {
      const ne = err as NatsError;
      if (ne.isJetStreamError()) {
        ne.message = ne.api_error?.description!;
        ne.code = `${ne.api_error?.code!}`;
        return Promise.reject(ne);
      }
      return Promise.reject(err);
    }
  }

  async get(
    k: string,
    opts?: { revision: number },
  ): Promise<KvEntry | null> {
    const ek = this.encodeKey(k);
    this.validateKey(ek);

    let arg: MsgRequest = { last_by_subj: this.subjectForKey(ek) };
    if (opts && opts.revision > 0) {
      arg = { seq: opts.revision };
    }

    let sm: StoredMsg;
    try {
      if (this.direct) {
        const direct =
          (this.jsm as unknown as { direct: DirectStreamAPI }).direct;
        sm = await direct.getMessage(this.bucketName(), arg);
      } else {
        sm = await this.jsm.streams.getMessage(this.bucketName(), arg);
      }
      const ke = this.smToEntry(sm);
      if (ke.key !== ek) {
        return null;
      }
      return ke;
    } catch (err) {
      if (
        (err as NatsError).code === ErrorCode.JetStream404NoMessages
      ) {
        return null;
      }
      throw err;
    }
  }

  purge(k: string, opts?: Partial<KvDeleteOptions>): Promise<void> {
    return this._deleteOrPurge(k, "PURGE", opts);
  }

  delete(k: string, opts?: Partial<KvDeleteOptions>): Promise<void> {
    return this._deleteOrPurge(k, "DEL", opts);
  }

  async purgeDeletes(
    olderMillis: number = 30 * 60 * 1000,
  ): Promise<PurgeResponse> {
    const buf: KvEntry[] = [];
    const i = await this.history({
      key: ">",
    });
    await (async () => {
      for await (const e of i) {
        if (e.operation === "DEL" || e.operation === "PURGE") {
          buf.push(e);
        }
      }
    })().then();
    i.stop();
    const min = Date.now() - olderMillis;
    const proms = buf.map((e) => {
      const subj = this.subjectForKey(e.key);
      if (e.created.getTime() >= min) {
        return this.jsm.streams.purge(this.stream, { filter: subj, keep: 1 });
      } else {
        return this.jsm.streams.purge(this.stream, { filter: subj, keep: 0 });
      }
    });
    const purged = await Promise.all(proms);
    purged.unshift({ success: true, purged: 0 });
    return purged.reduce((pv: PurgeResponse, cv: PurgeResponse) => {
      pv.purged += cv.purged;
      return pv;
    });
  }

  async _deleteOrPurge(
    k: string,
    op: "DEL" | "PURGE",
    opts?: Partial<KvDeleteOptions>,
  ): Promise<void> {
    if (!this.hasWildcards(k)) {
      return this._doDeleteOrPurge(k, op, opts);
    }
    const iter = await this.keys(k);
    const buf: Promise<void>[] = [];
    for await (const k of iter) {
      buf.push(this._doDeleteOrPurge(k, op));
      if (buf.length === 100) {
        await Promise.all(buf);
        buf.length = 0;
      }
    }
    if (buf.length > 0) {
      await Promise.all(buf);
    }
  }

  async _doDeleteOrPurge(
    k: string,
    op: "DEL" | "PURGE",
    opts?: Partial<KvDeleteOptions>,
  ): Promise<void> {
    const ek = this.encodeKey(k);
    this.validateKey(ek);
    const h = headers();
    h.set(kvOperationHdr, op);
    if (op === "PURGE") {
      h.set(JsHeaders.RollupHdr, JsHeaders.RollupValueSubject);
    }
    if (opts?.previousSeq) {
      h.set(PubHeaders.ExpectedLastSubjectSequenceHdr, `${opts.previousSeq}`);
    }
    await this.js.publish(this.subjectForKey(ek, true), Empty, { headers: h });
  }

  _buildCC(
    k: string | string[],
    content: KvWatchInclude,
    opts: Partial<ConsumerConfig> = {},
  ): Partial<ConsumerConfig> {
    const a = !Array.isArray(k) ? [k] : k;
    let filter_subjects: string[] | undefined = a.map((k) => {
      const ek = this.encodeKey(k);
      this.validateSearchKey(k);
      return this.fullKeyName(ek);
    });

    let deliver_policy = DeliverPolicy.LastPerSubject;
    if (content === KvWatchInclude.AllHistory) {
      deliver_policy = DeliverPolicy.All;
    }
    if (content === KvWatchInclude.UpdatesOnly) {
      deliver_policy = DeliverPolicy.New;
    }

    let filter_subject: undefined | string = undefined;
    if (filter_subjects.length === 1) {
      filter_subject = filter_subjects[0];
      filter_subjects = undefined;
    }

    return Object.assign({
      deliver_policy,
      "ack_policy": AckPolicy.None,
      filter_subjects,
      filter_subject,
      "flow_control": true,
      "idle_heartbeat": nanos(5 * 1000),
    }, opts) as Partial<ConsumerConfig>;
  }

  remove(k: string): Promise<void> {
    return this.purge(k);
  }

  async history(
    opts: { key?: string | string[]; headers_only?: boolean } = {},
  ): Promise<QueuedIterator<KvWatchEntry>> {
    const k = opts.key ?? ">";
    const co = {} as ConsumerConfig;
    co.headers_only = opts.headers_only || false;

    const qi = new QueuedIteratorImpl<KvWatchEntry>();
    const fn = () => {
      qi.stop();
    };

    const cc = this._buildCC(k, KvWatchInclude.AllHistory, co);
    const oc = await this.js.consumers.getPushConsumer(this.stream, cc);
    qi._data = oc;
    const info = await oc.info(true);
    if (info.num_pending === 0) {
      qi.push(fn);
      return qi;
    }

    const iter = await oc.consume({
      callback: (m) => {
        const e = this.jmToWatchEntry(m, false);
        qi.push(e);
        qi.received++;
        if (m.info.pending === 0) {
          qi.push(fn);
        }
      },
    });

    iter.closed().then(() => {
      qi.push(fn);
    });

    // if they break from the iterator stop the consumer
    qi.iterClosed.then(() => {
      iter.stop();
    });

    return qi;
  }

  canSetWatcherName(): boolean {
    //@ts-ignore: avoiding circular dependencies
    const nci = this.js.nc as NatsConnectionImpl;
    const { ok } = nci.features.get(
      Feature.JS_NEW_CONSUMER_CREATE_API,
    );
    return ok;
  }

  async watch(
    opts: KvWatchOptions = {},
  ): Promise<QueuedIterator<KvWatchEntry>> {
    const k = opts.key ?? ">";
    const qi = new QueuedIteratorImpl<KvWatchEntry>();
    const co = {} as Partial<ConsumerConfig>;
    co.headers_only = opts.headers_only || false;

    let content = KvWatchInclude.LastValue;
    if (opts.include === KvWatchInclude.AllHistory) {
      content = KvWatchInclude.AllHistory;
    } else if (opts.include === KvWatchInclude.UpdatesOnly) {
      content = KvWatchInclude.UpdatesOnly;
    }
    const ignoreDeletes = opts.ignoreDeletes === true;

    const cc = this._buildCC(k, content, co);
    cc.name = `KV_WATCHER_${nuid.next()}`;
    if (opts.resumeFromRevision && opts.resumeFromRevision > 0) {
      cc.deliver_policy = DeliverPolicy.StartSequence;
      cc.opt_start_seq = opts.resumeFromRevision;
    }

    const oc = await this.js.consumers.getPushConsumer(this.stream, cc);
    const info = await oc.info(true);
    const count = info.num_pending;
    let isUpdate = content === KvWatchInclude.UpdatesOnly || count === 0;

    qi._data = oc;
    const iter = await oc.consume({
      callback: (m) => {
        if (!isUpdate) {
          isUpdate = qi.received >= count;
        }
        const e = this.jmToWatchEntry(m, isUpdate);
        if (ignoreDeletes && e.operation === "DEL") {
          return;
        }
        qi.push(e);
        qi.received++;
      },
    });

    qi.iterClosed.then(() => {
      iter.stop();
    });
    iter.closed().then(() => {
      qi.push(() => {
        qi.stop();
      });
    });

    return qi;
  }

  async keys(k: string | string[] = ">"): Promise<QueuedIterator<string>> {
    const keys = new QueuedIteratorImpl<string>();
    const cc = this._buildCC(k, KvWatchInclude.LastValue, {
      headers_only: true,
    });

    const oc = await this.js.consumers.getPushConsumer(this.stream, cc);
    const info = await oc.info();
    if (info.num_pending === 0) {
      keys.stop();
      return keys;
    }

    keys._data = oc;

    const iter = await oc.consume({
      callback: (m) => {
        const op = m.headers?.get(kvOperationHdr);
        if (op !== "DEL" && op !== "PURGE") {
          const key = this.decodeKey(m.subject.substring(this.prefixLen));
          keys.push(key);
        }
        if (m.info.pending === 0) {
          iter.stop();
        }
      },
    });

    iter.closed().then(() => {
      keys.push(() => {
        keys.stop();
      });
    });
    keys.iterClosed.then(() => {
      iter.stop();
    });

    return keys;
  }

  purgeBucket(opts?: PurgeOpts): Promise<PurgeResponse> {
    return this.jsm.streams.purge(this.bucketName(), opts);
  }

  destroy(): Promise<boolean> {
    return this.jsm.streams.delete(this.bucketName());
  }

  async status(): Promise<KvStatus> {
    const nc = (this.js as unknown as { nc: NatsConnection }).nc;
    const cluster = nc.info?.cluster ?? "";
    const bn = this.bucketName();
    const si = await this.jsm.streams.info(bn);
    return new KvStatusImpl(si, cluster);
  }
}

export class KvStatusImpl implements KvStatus {
  si: StreamInfo;
  cluster: string;

  constructor(si: StreamInfo, cluster = "") {
    this.si = si;
    this.cluster = cluster;
  }

  get bucket(): string {
    return this.si.config.name.startsWith(kvPrefix)
      ? this.si.config.name.substring(kvPrefix.length)
      : this.si.config.name;
  }

  get values(): number {
    return this.si.state.messages;
  }

  get history(): number {
    return this.si.config.max_msgs_per_subject;
  }

  get ttl(): number {
    return millis(this.si.config.max_age);
  }

  get bucket_location(): string {
    return this.cluster;
  }

  get backingStore(): StorageType {
    return this.si.config.storage;
  }

  get storage(): StorageType {
    return this.si.config.storage;
  }

  get replicas(): number {
    return this.si.config.num_replicas;
  }

  get description(): string {
    return this.si.config.description ?? "";
  }

  get maxBucketSize(): number {
    return this.si.config.max_bytes;
  }

  get maxValueSize(): number {
    return this.si.config.max_msg_size;
  }

  get max_bytes(): number {
    return this.si.config.max_bytes;
  }

  get placement(): Placement {
    return this.si.config.placement || { cluster: "", tags: [] };
  }

  get placementCluster(): string {
    return this.si.config.placement?.cluster ?? "";
  }

  get republish(): Republish {
    return this.si.config.republish ?? { src: "", dest: "" };
  }

  get streamInfo(): StreamInfo {
    return this.si;
  }

  get size(): number {
    return this.si.state.bytes;
  }

  get metadata(): Record<string, string> {
    return this.si.config.metadata ?? {};
  }

  get compression(): boolean {
    if (this.si.config.compression) {
      return this.si.config.compression !== StoreCompression.None;
    }
    return false;
  }
}

class KvStoredEntryImpl implements KvEntry {
  bucket: string;
  sm: StoredMsg;
  prefixLen: number;

  constructor(bucket: string, prefixLen: number, sm: StoredMsg) {
    this.bucket = bucket;
    this.prefixLen = prefixLen;
    this.sm = sm;
  }

  get key(): string {
    return this.sm.subject.substring(this.prefixLen);
  }

  get value(): Uint8Array {
    return this.sm.data;
  }

  get delta(): number {
    return 0;
  }

  get created(): Date {
    return this.sm.time;
  }

  get revision(): number {
    return this.sm.seq;
  }

  get operation(): OperationType {
    return this.sm.header.get(kvOperationHdr) as OperationType || "PUT";
  }

  get length(): number {
    const slen = this.sm.header.get(JsHeaders.MessageSizeHdr) || "";
    if (slen !== "") {
      return parseInt(slen, 10);
    }
    return this.sm.data.length;
  }

  json<T>(): T {
    return this.sm.json();
  }

  string(): string {
    return this.sm.string();
  }
}

class KvJsMsgEntryImpl implements KvEntry, KvWatchEntry {
  bucket: string;
  key: string;
  sm: JsMsg;
  update: boolean;

  constructor(bucket: string, key: string, sm: JsMsg, isUpdate: boolean) {
    this.bucket = bucket;
    this.key = key;
    this.sm = sm;
    this.update = isUpdate;
  }

  get value(): Uint8Array {
    return this.sm.data;
  }

  get created(): Date {
    return new Date(millis(this.sm.info.timestampNanos));
  }

  get revision(): number {
    return this.sm.seq;
  }

  get operation(): OperationType {
    return this.sm.headers?.get(kvOperationHdr) as OperationType || "PUT";
  }

  get delta(): number {
    return this.sm.info.pending;
  }

  get length(): number {
    const slen = this.sm.headers?.get(JsHeaders.MessageSizeHdr) || "";
    if (slen !== "") {
      return parseInt(slen, 10);
    }
    return this.sm.data.length;
  }

  get isUpdate(): boolean {
    return this.update;
  }

  json<T>(): T {
    return this.sm.json();
  }

  string(): string {
    return this.sm.string();
  }
}
