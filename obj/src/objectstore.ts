/*
 * Copyright 2022-2025 The NATS Authors
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

import type {
  MsgHdrs,
  NatsConnection,
  QueuedIterator,
} from "@nats-io/nats-core/internal";
import {
  DataBuffer,
  deferred,
  Feature,
  headers,
  MsgHdrsImpl,
  nanos,
  nuid,
  QueuedIteratorImpl,
} from "@nats-io/nats-core/internal";

import type {
  ConsumerConfig,
  JetStreamClient,
  JetStreamClientImpl,
  JetStreamManager,
  JsMsg,
  Lister,
  ListerFieldFilter,
  PubAck,
  PurgeResponse,
  PushConsumerMessagesImpl,
  StorageType,
  StreamConfig,
  StreamInfo,
  StreamInfoRequestOptions,
  StreamListResponse,
} from "@nats-io/jetstream/internal";
import {
  DeliverPolicy,
  DiscardPolicy,
  isMessageNotFound,
  JetStreamApiCodes,
  JetStreamApiError,
  JsHeaders,
  ListerImpl,
  PubHeaders,
  StoreCompression,
  toJetStreamClient,
} from "@nats-io/jetstream/internal";

import type {
  ObjectInfo,
  ObjectResult,
  ObjectStore,
  ObjectStoreMeta,
  ObjectStoreMetaOptions,
  ObjectStoreOptions,
  ObjectStorePutOpts,
  ObjectStoreStatus,
  ObjectWatchInfo,
} from "./types.ts";
import { Base64UrlPaddedCodec } from "./base64.ts";
import { sha256 } from "js-sha256";
import { checkSha256, parseSha256 } from "./sha_digest.parser.ts";

export const osPrefix = "OBJ_";
export const digestType = "SHA-256=";

export function objectStoreStreamName(bucket: string): string {
  validateBucket(bucket);
  return `${osPrefix}${bucket}`;
}

export function objectStoreBucketName(stream: string): string {
  if (stream.startsWith(osPrefix)) {
    return stream.substring(4);
  }
  return stream;
}

/**
 * The entry point to creating and managing new ObjectStore instances.
 */
export class Objm {
  js: JetStreamClientImpl;

  /**
   * Creates an instance of the Objm that allows you to create and access ObjectStore.
   * Note that if the argument is a NatsConnection, default JetStream Options are
   * used. If you want to set some options, please provide a JetStreamClient instead.
   * @param nc
   */
  constructor(nc: JetStreamClient | NatsConnection) {
    this.js = toJetStreamClient(nc) as JetStreamClientImpl;
  }

  /**
   * Creates and opens the specified ObjectStore. If the ObjectStore already exists,
   * it opens the existing ObjectStore.
   * @param name
   * @param opts
   */
  create(
    name: string,
    opts: Partial<ObjectStoreOptions> = {},
  ): Promise<ObjectStore> {
    return this.#maybeCreate(name, opts);
  }

  /**
   * Opens the specified ObjectStore
   * @param name
   * @param check - if set to false, it will not check if the ObjectStore exists.
   */
  async open(name: string, check = true): Promise<ObjectStore> {
    const jsm = await this.js.jetstreamManager();
    const os = new ObjectStoreImpl(name, jsm, this.js);
    os.stream = objectStoreStreamName(name);
    if (check) {
      await os.status();
    }
    return Promise.resolve(os);
  }

  #maybeCreate(
    name: string,
    opts: Partial<ObjectStoreOptions> = {},
  ): Promise<ObjectStore> {
    if (typeof crypto?.subtle?.digest !== "function") {
      return Promise.reject(
        new Error(
          "objectstore: unable to calculate hashes - crypto.subtle.digest with sha256 support is required",
        ),
      );
    }
    const { ok, min } = this.js.nc.features.get(Feature.JS_OBJECTSTORE);
    if (!ok) {
      return Promise.reject(
        new Error(`objectstore is only supported on servers ${min} or better`),
      );
    }

    return ObjectStoreImpl.create(this.js, name, opts);
  }

  /**
   * Returns a list of ObjectStoreStatus for all streams that are identified as
   * being a ObjectStore (that is having names that have the prefix `OBJ_`)
   */
  list(): Lister<ObjectStoreStatus> {
    const filter: ListerFieldFilter<ObjectStoreStatus> = (
      v: unknown,
    ): ObjectStoreStatus[] => {
      const slr = v as StreamListResponse;
      const streams = slr.streams.filter((v) => {
        return v.config.name.startsWith(osPrefix);
      });
      streams.forEach((si) => {
        si.config.sealed = si.config.sealed || false;
        si.config.deny_delete = si.config.deny_delete || false;
        si.config.deny_purge = si.config.deny_purge || false;
        si.config.allow_rollup_hdrs = si.config.allow_rollup_hdrs || false;
      });
      return streams.map((si) => {
        return new ObjectStoreStatusImpl(si);
      });
    };
    const subj = `${this.js.prefix}.STREAM.LIST`;
    return new ListerImpl<ObjectStoreStatus>(subj, filter, this.js);
  }
}

export class ObjectStoreStatusImpl implements ObjectStoreStatus {
  si: StreamInfo;
  backingStore: string;

  constructor(si: StreamInfo) {
    this.si = si;
    this.backingStore = "JetStream";
  }
  get bucket(): string {
    return objectStoreBucketName(this.si.config.name);
  }
  get description(): string {
    return this.si.config.description ?? "";
  }
  get ttl(): number {
    return this.si.config.max_age;
  }
  get storage(): StorageType {
    return this.si.config.storage;
  }
  get replicas(): number {
    return this.si.config.num_replicas;
  }
  get sealed(): boolean {
    return this.si.config.sealed;
  }
  get size(): number {
    return this.si.state.bytes;
  }
  get streamInfo(): StreamInfo {
    return this.si;
  }
  get metadata(): Record<string, string> | undefined {
    return this.si.config.metadata;
  }

  get compression(): boolean {
    if (this.si.config.compression) {
      return this.si.config.compression !== StoreCompression.None;
    }
    return false;
  }
}
export function validateBucket(name: string) {
  const validBucketRe = /^[-\w]+$/;
  if (!validBucketRe.test(name)) {
    throw new Error(`invalid bucket name: ${name}`);
  }
}

export type ServerObjectStoreMeta = {
  name: string;
  description?: string;
  headers?: Record<string, string[]>;
  options?: ObjectStoreMetaOptions;
};

export type ServerObjectInfo = {
  bucket: string;
  nuid: string;
  size: number;
  chunks: number;
  digest: string;
  deleted?: boolean;
  mtime: string;
  revision: number;
  metadata?: Record<string, string>;
} & ServerObjectStoreMeta;

class ObjectInfoImpl implements ObjectInfo {
  info: ServerObjectInfo;
  hdrs!: MsgHdrs;
  constructor(oi: ServerObjectInfo) {
    this.info = oi;
  }
  get name(): string {
    return this.info.name;
  }
  get description(): string {
    return this.info.description ?? "";
  }
  get headers(): MsgHdrs {
    if (!this.hdrs) {
      this.hdrs = MsgHdrsImpl.fromRecord(this.info.headers || {});
    }
    return this.hdrs;
  }
  get options(): ObjectStoreMetaOptions | undefined {
    return this.info.options;
  }
  get bucket(): string {
    return this.info.bucket;
  }
  get chunks(): number {
    return this.info.chunks;
  }
  get deleted(): boolean {
    return this.info.deleted ?? false;
  }
  get digest(): string {
    return this.info.digest;
  }
  get mtime(): string {
    return this.info.mtime;
  }
  get nuid(): string {
    return this.info.nuid;
  }
  get size(): number {
    return this.info.size;
  }
  get revision(): number {
    return this.info.revision;
  }
  get metadata(): Record<string, string> {
    return this.info.metadata || {};
  }
  isLink() {
    return (this.info.options?.link !== undefined) &&
      (this.info.options?.link !== null);
  }
}

function toServerObjectStoreMeta(
  meta: Partial<ObjectStoreMeta>,
): ServerObjectStoreMeta {
  const v = {
    name: meta.name,
    description: meta.description ?? "",
    options: meta.options,
    metadata: meta.metadata,
  } as ServerObjectStoreMeta;

  if (meta.headers) {
    const mhi = meta.headers as MsgHdrsImpl;
    v.headers = mhi.toRecord();
  }
  return v;
}

function emptyReadableStream(): ReadableStream {
  return new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(0));
      c.close();
    },
  });
}

export class ObjectStoreImpl implements ObjectStore {
  jsm: JetStreamManager;
  js: JetStreamClient;
  stream!: string;
  name: string;

  constructor(name: string, jsm: JetStreamManager, js: JetStreamClient) {
    this.name = name;
    this.jsm = jsm;
    this.js = js;
  }

  _checkNotEmpty(name: string): { name: string; error?: Error } {
    if (!name || name.length === 0) {
      return { name, error: new Error("name cannot be empty") };
    }
    return { name };
  }

  async info(name: string): Promise<ObjectInfo | null> {
    const info = await this.rawInfo(name);
    return info ? new ObjectInfoImpl(info) : null;
  }

  async list(): Promise<ObjectInfo[]> {
    const buf: ObjectInfo[] = [];
    const iter = await this.watch({
      ignoreDeletes: true,
      includeHistory: true,
      //@ts-ignore: hidden
      historyOnly: true,
    });

    // historyOnly will stop the iterator
    for await (const info of iter) {
      buf.push(info);
    }
    return Promise.resolve(buf);
  }

  async rawInfo(name: string): Promise<ServerObjectInfo | null> {
    const { name: obj, error } = this._checkNotEmpty(name);
    if (error) {
      return Promise.reject(error);
    }

    const meta = this._metaSubject(obj);
    try {
      const m = await this.jsm.streams.getMessage(this.stream, {
        last_by_subj: meta,
      });
      if (m === null) {
        return null;
      }
      const soi = m.json<ServerObjectInfo>();
      soi.revision = m.seq;
      return soi;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async _si(
    opts?: Partial<StreamInfoRequestOptions>,
  ): Promise<StreamInfo | null> {
    try {
      return await this.jsm.streams.info(this.stream, opts);
    } catch (err) {
      if (
        err instanceof JetStreamApiError &&
        err.code === JetStreamApiCodes.StreamNotFound
      ) {
        return null;
      }
      return Promise.reject(err);
    }
  }

  async seal(): Promise<ObjectStoreStatus> {
    let info = await this._si();
    if (info === null) {
      return Promise.reject(new Error("object store not found"));
    }
    info.config.sealed = true;
    info = await this.jsm.streams.update(this.stream, info.config);
    return Promise.resolve(new ObjectStoreStatusImpl(info));
  }

  async status(
    opts?: Partial<StreamInfoRequestOptions>,
  ): Promise<ObjectStoreStatus> {
    const info = await this._si(opts);
    if (info === null) {
      return Promise.reject(new Error("object store not found"));
    }
    return Promise.resolve(new ObjectStoreStatusImpl(info));
  }

  destroy(): Promise<boolean> {
    return this.jsm.streams.delete(this.stream);
  }

  async _put(
    meta: ObjectStoreMeta,
    rs: ReadableStream<Uint8Array> | null,
    opts?: ObjectStorePutOpts,
  ): Promise<ObjectInfo> {
    const jsopts = this.js.getOptions();
    opts = opts || { timeout: jsopts.timeout };
    opts.timeout = opts.timeout || jsopts.timeout;
    opts.previousRevision = opts.previousRevision ?? undefined;
    const { timeout, previousRevision } = opts;
    const si = (this.js as unknown as { nc: NatsConnection }).nc.info;
    const maxPayload = si?.max_payload || 1024;
    meta = meta || {} as ObjectStoreMeta;
    meta.options = meta.options || {};
    let maxChunk = meta.options?.max_chunk_size || 128 * 1024;
    maxChunk = maxChunk > maxPayload ? maxPayload : maxChunk;
    meta.options.max_chunk_size = maxChunk;

    const old = await this.info(meta.name);
    const { name: n, error } = this._checkNotEmpty(meta.name);
    if (error) {
      return Promise.reject(error);
    }

    const id = nuid.next();
    const chunkSubj = this._chunkSubject(id);
    const metaSubj = this._metaSubject(n);

    const info = Object.assign({
      bucket: this.name,
      nuid: id,
      size: 0,
      chunks: 0,
    }, toServerObjectStoreMeta(meta)) as ServerObjectInfo;

    const d = deferred<ObjectInfo>();

    const db = new DataBuffer();
    try {
      const reader = rs ? rs.getReader() : null;
      const sha = sha256.create();

      while (true) {
        const { done, value } = reader
          ? await reader.read()
          : { done: true, value: undefined };
        if (done) {
          // put any partial chunk in
          if (db.size() > 0) {
            const payload = db.drain();
            sha.update(payload);
            info.chunks!++;
            info.size! += payload.length;
            await this.js.publish(chunkSubj, payload, { timeout });
          }

          // prepare the metadata
          info.mtime = new Date().toISOString();
          const digest = Base64UrlPaddedCodec.encode(
            Uint8Array.from(sha.digest()),
          );
          info.digest = `${digestType}${digest}`;

          info.deleted = false;

          // trailing md for the object
          const h = headers();
          if (typeof previousRevision === "number") {
            h.set(
              PubHeaders.ExpectedLastSubjectSequenceHdr,
              `${previousRevision}`,
            );
          }
          h.set(JsHeaders.RollupHdr, JsHeaders.RollupValueSubject);

          // try to update the metadata
          const pa = await this.js.publish(metaSubj, JSON.stringify(info), {
            headers: h,
            timeout,
          });
          // update the revision to point to the sequence where we inserted
          info.revision = pa.seq;

          // if we are here, the new entry is live
          if (old) {
            try {
              await this.jsm.streams.purge(this.stream, {
                filter: `$O.${this.name}.C.${old.nuid}`,
              });
            } catch (_err) {
              // rejecting here, would mean send the wrong signal
              // the update succeeded, but cleanup of old chunks failed.
            }
          }

          // resolve the ObjectInfo
          d.resolve(new ObjectInfoImpl(info!));
          // stop
          break;
        }
        if (value) {
          db.fill(value);
          while (db.size() > maxChunk) {
            info.chunks!++;
            info.size! += maxChunk;
            const payload = db.drain(meta.options.max_chunk_size);
            sha.update(payload);
            await this.js.publish(chunkSubj, payload, { timeout });
          }
        }
      }
    } catch (err) {
      // we failed, remove any partials
      await this.jsm.streams.purge(this.stream, { filter: chunkSubj });
      d.reject(err);
    }

    return d;
  }

  putBlob(
    meta: ObjectStoreMeta,
    data: Uint8Array | null,
    opts?: ObjectStorePutOpts,
  ): Promise<ObjectInfo> {
    function readableStreamFrom(data: Uint8Array): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
    }
    if (data === null) {
      data = new Uint8Array(0);
    }
    return this.put(meta, readableStreamFrom(data), opts);
  }

  put(
    meta: ObjectStoreMeta,
    rs: ReadableStream<Uint8Array> | null,
    opts?: ObjectStorePutOpts,
  ): Promise<ObjectInfo> {
    if (meta?.options?.link) {
      return Promise.reject(
        new Error("link cannot be set when putting the object in bucket"),
      );
    }
    return this._put(meta, rs, opts);
  }

  async getBlob(name: string): Promise<Uint8Array | null> {
    async function fromReadableStream(
      rs: ReadableStream<Uint8Array>,
    ): Promise<Uint8Array> {
      const buf = new DataBuffer();
      const reader = rs.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return buf.drain();
        }
        if (value && value.length) {
          buf.fill(value);
        }
      }
    }

    const r = await this.get(name);
    if (r === null) {
      return Promise.resolve(null);
    }

    const vs = await Promise.all([r.error, fromReadableStream(r.data)]);
    if (vs[0]) {
      return Promise.reject(vs[0]);
    } else {
      return Promise.resolve(vs[1]);
    }
  }

  async get(name: string): Promise<ObjectResult | null> {
    const info = await this.rawInfo(name);
    if (info === null) {
      return Promise.resolve(null);
    }

    if (info.deleted) {
      return Promise.resolve(null);
    }

    if (info.options && info.options.link) {
      const ln = info.options.link.name || "";
      if (ln === "") {
        throw new Error("link is a bucket");
      }
      const os = info.options.link.bucket !== this.name
        ? await ObjectStoreImpl.create(
          this.js,
          info.options.link.bucket,
        )
        : this;
      return os.get(ln);
    }

    if (!info.digest.startsWith(digestType)) {
      return Promise.reject(new Error(`unknown digest type: ${info.digest}`));
    }
    const digest = parseSha256(info.digest.substring(8));
    if (digest === null) {
      return Promise.reject(
        new Error(`unable to parse digest: ${info.digest}`),
      );
    }

    const d = deferred<Error | null>();

    const r: Partial<ObjectResult> = {
      info: new ObjectInfoImpl(info),
      error: d,
    };
    if (info.size === 0) {
      r.data = emptyReadableStream();
      d.resolve(null);
      return Promise.resolve(r as ObjectResult);
    }

    const sha = sha256.create();
    let controller: ReadableStreamDefaultController;

    const cc: Partial<ConsumerConfig> = {};
    cc.filter_subject = `$O.${this.name}.C.${info.nuid}`;
    cc.idle_heartbeat = nanos(30_000);
    cc.flow_control = true;
    const oc = await this.js.consumers.getPushConsumer(this.stream, cc);
    const iter = await oc.consume() as PushConsumerMessagesImpl;

    (async () => {
      for await (const jm of iter) {
        if (jm.data.length > 0) {
          sha.update(jm.data);
          controller!.enqueue(jm.data);
        }
        if (jm.info.pending === 0) {
          const digest = Uint8Array.from(sha.digest());
          if (!checkSha256(digest, Uint8Array.from(sha.digest()))) {
            controller!.error(
              new Error(
                `received a corrupt object, digests do not match received: ${info.digest} calculated ${digest}`,
              ),
            );
          } else {
            controller!.close();
          }
          break;
        }
      }
    })()
      .then(() => {
        d.resolve();
      })
      .catch((err) => {
        controller!.error(err);
        d.reject(err);
      });

    r.data = new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
        iter.stop();
      },
    });

    return r as ObjectResult;
  }

  linkStore(name: string, bucket: ObjectStore): Promise<ObjectInfo> {
    if (!(bucket instanceof ObjectStoreImpl)) {
      return Promise.reject("bucket required");
    }
    const osi = bucket as ObjectStoreImpl;
    const { name: n, error } = this._checkNotEmpty(name);
    if (error) {
      return Promise.reject(error);
    }

    const meta = {
      name: n,
      options: { link: { bucket: osi.name } },
    };
    return this._put(meta, null);
  }

  async link(name: string, info: ObjectInfo): Promise<ObjectInfo> {
    const { name: n, error } = this._checkNotEmpty(name);
    if (error) {
      return Promise.reject(error);
    }
    if (info.deleted) {
      return Promise.reject(new Error("src object is deleted"));
    }
    if ((info as ObjectInfoImpl).isLink()) {
      return Promise.reject(new Error("src object is a link"));
    }
    const dest = await this.rawInfo(name);
    if (dest !== null && !dest.deleted) {
      return Promise.reject(
        new Error("an object already exists with that name"),
      );
    }

    const link = { bucket: info.bucket, name: info.name };
    const mm = {
      name: n,
      bucket: info.bucket,
      options: { link: link },
    } as ObjectStoreMeta;
    await this.js.publish(this._metaSubject(name), JSON.stringify(mm));
    const i = await this.info(name);
    return Promise.resolve(i!);
  }

  async delete(name: string): Promise<PurgeResponse> {
    const info = await this.rawInfo(name);
    if (info === null) {
      return Promise.resolve({ purged: 0, success: false });
    }
    info.deleted = true;
    info.size = 0;
    info.chunks = 0;
    info.digest = "";

    const h = headers();
    h.set(JsHeaders.RollupHdr, JsHeaders.RollupValueSubject);

    await this.js.publish(this._metaSubject(info.name), JSON.stringify(info), {
      headers: h,
    });
    return this.jsm.streams.purge(this.stream, {
      filter: this._chunkSubject(info.nuid),
    });
  }

  async update(
    name: string,
    meta: Partial<ObjectStoreMeta> = {},
  ): Promise<PubAck> {
    const info = await this.rawInfo(name);
    if (info === null) {
      return Promise.reject(new Error("object not found"));
    }
    if (info.deleted) {
      return Promise.reject(
        new Error("cannot update meta for a deleted object"),
      );
    }
    meta.name = meta.name ?? info.name;
    const { name: n, error } = this._checkNotEmpty(meta.name);
    if (error) {
      return Promise.reject(error);
    }
    if (name !== meta.name) {
      const i = await this.info(meta.name);
      if (i && !i.deleted) {
        return Promise.reject(
          new Error("an object already exists with that name"),
        );
      }
    }
    meta.name = n;
    const ii = Object.assign({}, info, toServerObjectStoreMeta(meta!));
    // if the name changed, delete the old meta
    const ack = await this.js.publish(
      this._metaSubject(ii.name),
      JSON.stringify(ii),
    );
    if (name !== meta.name) {
      await this.jsm.streams.purge(this.stream, {
        filter: this._metaSubject(name),
      });
    }
    return Promise.resolve(ack);
  }

  async watch(opts: Partial<
    {
      ignoreDeletes?: boolean;
      includeHistory?: boolean;
    }
  > = {}): Promise<QueuedIterator<ObjectWatchInfo>> {
    opts.includeHistory = opts.includeHistory ?? false;
    opts.ignoreDeletes = opts.ignoreDeletes ?? false;
    // @ts-ignore: not exposed
    const historyOnly = opts.historyOnly ?? false;
    const qi = new QueuedIteratorImpl<ObjectWatchInfo>();
    const subj = this._metaSubjectAll();
    try {
      await this.jsm.streams.getMessage(this.stream, { last_by_subj: subj });
    } catch (err) {
      if (!isMessageNotFound(err as Error)) {
        qi.stop(err as Error);
      }
    }
    const cc: Partial<ConsumerConfig> = {};
    cc.name = `OBJ_WATCHER_${nuid.next()}`;
    cc.filter_subject = subj;
    if (opts.includeHistory) {
      cc.deliver_policy = DeliverPolicy.LastPerSubject;
    } else {
      // FIXME: Go's implementation doesn't seem correct - if history is not desired
      //  the watch should only be giving notifications on new entries
      cc.deliver_policy = DeliverPolicy.New;
    }

    const oc = await this.js.consumers.getPushConsumer(this.stream, cc);
    const info = await oc.info(true);
    const count = info.num_pending;
    let isUpdate = cc.deliver_policy === DeliverPolicy.New || count === 0;
    qi._data = oc;
    let i = 0;
    const iter = await oc.consume({
      callback: (jm: JsMsg) => {
        if (!isUpdate) {
          i++;
          isUpdate = i >= count;
        }
        const oi = jm.json<ObjectWatchInfo>();
        oi.isUpdate = isUpdate;
        if (oi.deleted && opts.ignoreDeletes === true) {
          // do nothing
        } else {
          qi.push(oi);
        }
        if (historyOnly && i === count) {
          iter.stop();
        }
      },
    });

    (async () => {
      for await (const s of iter.status()) {
        switch (s.type) {
          case "heartbeat":
            if (historyOnly) {
              // we got all the keys...
              qi.push(() => {
                qi.stop();
              });
            }
        }
      }
    })().then();

    if (historyOnly && count === 0) {
      iter.stop();
    }

    iter.closed().then(() => {
      qi.push(() => {
        qi.stop();
      });
    });
    qi.iterClosed.then(() => {
      iter.stop();
    });

    return qi;
  }

  _chunkSubject(id: string) {
    return `$O.${this.name}.C.${id}`;
  }

  _metaSubject(n: string): string {
    return `$O.${this.name}.M.${Base64UrlPaddedCodec.encode(n)}`;
  }

  _metaSubjectAll(): string {
    return `$O.${this.name}.M.>`;
  }

  async init(opts: Partial<ObjectStoreOptions> = {}): Promise<void> {
    try {
      this.stream = objectStoreStreamName(this.name);
    } catch (err) {
      return Promise.reject(err);
    }
    const max_age = opts?.ttl || 0;
    delete opts.ttl;
    // pacify the tsc compiler downstream
    const sc = Object.assign({ max_age }, opts) as unknown as StreamConfig;
    sc.name = this.stream;
    sc.allow_direct = true;
    sc.allow_rollup_hdrs = true;
    sc.num_replicas = opts.replicas || 1;
    sc.discard = DiscardPolicy.New;
    sc.subjects = [`$O.${this.name}.C.>`, `$O.${this.name}.M.>`];
    if (opts.placement) {
      sc.placement = opts.placement;
    }
    if (opts.metadata) {
      sc.metadata = opts.metadata;
    }
    if (typeof opts.compression === "boolean") {
      sc.compression = opts.compression
        ? StoreCompression.S2
        : StoreCompression.None;
    }

    try {
      await this.jsm.streams.info(sc.name);
    } catch (err) {
      if ((err as Error).message === "stream not found") {
        await this.jsm.streams.add(sc);
      }
    }
  }

  static async create(
    js: JetStreamClient,
    name: string,
    opts: Partial<ObjectStoreOptions> = {},
  ): Promise<ObjectStore> {
    const jsm = await js.jetstreamManager();
    const os = new ObjectStoreImpl(name, jsm, js);
    await os.init(opts);
    return Promise.resolve(os);
  }
}
