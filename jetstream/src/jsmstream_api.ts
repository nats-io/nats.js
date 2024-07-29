/*
 * Copyright 2021-2023 The NATS Authors
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
  Empty,
  Feature,
  headers,
  JSONCodec,
  MsgHdrsImpl,
  TD,
} from "@nats-io/nats-core/internal";
import type {
  Codec,
  MsgHdrs,
  NatsConnection,
  NatsConnectionImpl,
  ReviverFn,
} from "@nats-io/nats-core/internal";
import { BaseApiClientImpl } from "./jsbaseclient_api.ts";
import type { StreamNames } from "./jsbaseclient_api.ts";
import { ListerImpl } from "./jslister.ts";
import { validateStreamName } from "./jsutil.ts";
import type {
  Consumer,
  ConsumerAPI,
  Consumers,
  JetStreamOptions,
  Lister,
  ListerFieldFilter,
  OrderedConsumerOptions,
  StoredMsg,
  Stream,
  StreamAPI,
  Streams,
} from "./types.ts";
import type {
  ApiPagedRequest,
  ExternalStream,
  MsgDeleteRequest,
  MsgRequest,
  PurgeBySeq,
  PurgeOpts,
  PurgeResponse,
  PurgeTrimOpts,
  StreamAlternate,
  StreamConfig,
  StreamInfo,
  StreamInfoRequestOptions,
  StreamListResponse,
  StreamMsgResponse,
  StreamSource,
  StreamUpdateConfig,
  SuccessResponse,
} from "./jsapi_types.ts";
import { OrderedPullConsumerImpl, PullConsumerImpl } from "./consumer.ts";
import { ConsumerAPIImpl } from "./jsmconsumer_api.ts";

export function convertStreamSourceDomain(s?: StreamSource) {
  if (s === undefined) {
    return undefined;
  }
  const { domain } = s;
  if (domain === undefined) {
    return s;
  }
  const copy = Object.assign({}, s) as StreamSource;
  delete copy.domain;

  if (domain === "") {
    return copy;
  }
  if (copy.external) {
    throw new Error("domain and external are both set");
  }
  copy.external = { api: `$JS.${domain}.API` } as ExternalStream;
  return copy;
}

export class ConsumersImpl implements Consumers {
  api: ConsumerAPI;
  notified: boolean;

  constructor(api: ConsumerAPI) {
    this.api = api;
    this.notified = false;
  }

  checkVersion(): Promise<void> {
    const fv = (this.api as ConsumerAPIImpl).nc.features.get(
      Feature.JS_SIMPLIFICATION,
    );
    if (!fv.ok) {
      return Promise.reject(
        new Error(
          `consumers framework is only supported on servers ${fv.min} or better`,
        ),
      );
    }
    return Promise.resolve();
  }

  async get(
    stream: string,
    name: string | Partial<OrderedConsumerOptions> = {},
  ): Promise<Consumer> {
    if (typeof name === "object") {
      return this.ordered(stream, name);
    }
    // check we have support for pending msgs and header notifications
    await this.checkVersion();

    return this.api.info(stream, name)
      .then((ci) => {
        if (ci.config.deliver_subject !== undefined) {
          return Promise.reject(new Error("push consumer not supported"));
        }
        return new PullConsumerImpl(this.api, ci);
      })
      .catch((err) => {
        return Promise.reject(err);
      });
  }

  async ordered(
    stream: string,
    opts?: Partial<OrderedConsumerOptions>,
  ): Promise<Consumer> {
    await this.checkVersion();

    const impl = this.api as ConsumerAPIImpl;
    const sapi = new StreamAPIImpl(impl.nc, impl.opts);
    return sapi.info(stream)
      .then((_si) => {
        return Promise.resolve(
          new OrderedPullConsumerImpl(this.api, stream, opts),
        );
      })
      .catch((err) => {
        return Promise.reject(err);
      });
  }
}

export class StreamImpl implements Stream {
  api: StreamAPIImpl;
  _info: StreamInfo;

  constructor(api: StreamAPI, info: StreamInfo) {
    this.api = api as StreamAPIImpl;
    this._info = info;
  }

  get name(): string {
    return this._info.config.name;
  }

  alternates(): Promise<StreamAlternate[]> {
    return this.info()
      .then((si) => {
        return si.alternates ? si.alternates : [];
      });
  }

  async best(): Promise<Stream> {
    await this.info();
    if (this._info.alternates) {
      const asi = await this.api.info(this._info.alternates[0].name);
      return new StreamImpl(this.api, asi);
    } else {
      return this;
    }
  }

  info(
    cached = false,
    opts?: Partial<StreamInfoRequestOptions>,
  ): Promise<StreamInfo> {
    if (cached) {
      return Promise.resolve(this._info);
    }
    return this.api.info(this.name, opts)
      .then((si) => {
        this._info = si;
        return this._info;
      });
  }

  getConsumer(
    name?: string | Partial<OrderedConsumerOptions>,
  ): Promise<Consumer> {
    return new ConsumersImpl(new ConsumerAPIImpl(this.api.nc, this.api.opts))
      .get(this.name, name);
  }

  getMessage(query: MsgRequest): Promise<StoredMsg> {
    return this.api.getMessage(this.name, query);
  }

  deleteMessage(seq: number, erase?: boolean): Promise<boolean> {
    return this.api.deleteMessage(this.name, seq, erase);
  }
}

export class StreamAPIImpl extends BaseApiClientImpl implements StreamAPI {
  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    super(nc, opts);
  }

  checkStreamConfigVersions(cfg: Partial<StreamConfig>) {
    const nci = this.nc as unknown as NatsConnectionImpl;
    if (cfg.metadata) {
      const { min, ok } = nci.features.get(Feature.JS_STREAM_CONSUMER_METADATA);
      if (!ok) {
        throw new Error(`stream 'metadata' requires server ${min}`);
      }
    }
    if (cfg.first_seq) {
      const { min, ok } = nci.features.get(Feature.JS_STREAM_FIRST_SEQ);
      if (!ok) {
        throw new Error(`stream 'first_seq' requires server ${min}`);
      }
    }
    if (cfg.subject_transform) {
      const { min, ok } = nci.features.get(Feature.JS_STREAM_SUBJECT_TRANSFORM);
      if (!ok) {
        throw new Error(`stream 'subject_transform' requires server ${min}`);
      }
    }
    if (cfg.compression) {
      const { min, ok } = nci.features.get(Feature.JS_STREAM_COMPRESSION);
      if (!ok) {
        throw new Error(`stream 'compression' requires server ${min}`);
      }
    }
    if (cfg.consumer_limits) {
      const { min, ok } = nci.features.get(Feature.JS_DEFAULT_CONSUMER_LIMITS);
      if (!ok) {
        throw new Error(`stream 'consumer_limits' requires server ${min}`);
      }
    }

    function validateStreamSource(
      context: string,
      src: Partial<StreamSource>,
    ): void {
      const count = src?.subject_transforms?.length || 0;
      if (count > 0) {
        const { min, ok } = nci.features.get(
          Feature.JS_STREAM_SOURCE_SUBJECT_TRANSFORM,
        );
        if (!ok) {
          throw new Error(
            `${context} 'subject_transforms' requires server ${min}`,
          );
        }
      }
    }

    if (cfg.sources) {
      cfg.sources.forEach((src) => {
        validateStreamSource("stream sources", src);
      });
    }

    if (cfg.mirror) {
      validateStreamSource("stream mirror", cfg.mirror);
    }
  }

  async add(cfg = {} as Partial<StreamConfig>): Promise<StreamInfo> {
    this.checkStreamConfigVersions(cfg);
    validateStreamName(cfg.name);
    cfg.mirror = convertStreamSourceDomain(cfg.mirror);
    //@ts-ignore: the sources are either set or not - so no item should be undefined in the list
    cfg.sources = cfg.sources?.map(convertStreamSourceDomain);
    const r = await this._request(
      `${this.prefix}.STREAM.CREATE.${cfg.name}`,
      cfg,
    );
    const si = r as StreamInfo;
    this._fixInfo(si);

    return si;
  }

  async delete(stream: string): Promise<boolean> {
    validateStreamName(stream);
    const r = await this._request(`${this.prefix}.STREAM.DELETE.${stream}`);
    const cr = r as SuccessResponse;
    return cr.success;
  }

  async update(
    name: string,
    cfg = {} as Partial<StreamUpdateConfig>,
  ): Promise<StreamInfo> {
    if (typeof name === "object") {
      const sc = name as StreamConfig;
      name = sc.name;
      cfg = sc;
      console.trace(
        `\u001B[33m >> streams.update(config: StreamConfig) api changed to streams.update(name: string, config: StreamUpdateConfig) - this shim will be removed - update your code.  \u001B[0m`,
      );
    }
    this.checkStreamConfigVersions(cfg);
    validateStreamName(name);
    const old = await this.info(name);
    const update = Object.assign(old.config, cfg);
    update.mirror = convertStreamSourceDomain(update.mirror);
    //@ts-ignore: the sources are either set or not - so no item should be undefined in the list
    update.sources = update.sources?.map(convertStreamSourceDomain);

    const r = await this._request(
      `${this.prefix}.STREAM.UPDATE.${name}`,
      update,
    );
    const si = r as StreamInfo;
    this._fixInfo(si);
    return si;
  }

  async info(
    name: string,
    data?: Partial<StreamInfoRequestOptions>,
  ): Promise<StreamInfo> {
    validateStreamName(name);
    const subj = `${this.prefix}.STREAM.INFO.${name}`;
    const r = await this._request(subj, data);
    let si = r as StreamInfo;
    let { total, limit } = si;

    // check how many subjects we got in the first request
    let have = si.state.subjects
      ? Object.getOwnPropertyNames(si.state.subjects).length
      : 1;

    // if the response is paged, we have a large list of subjects
    // handle the paging and return a StreamInfo with all of it
    if (total && total > have) {
      const infos: StreamInfo[] = [si];
      const paged = data || {} as unknown as ApiPagedRequest;
      let i = 0;
      // total could change, so it is possible to have collected
      // more that the total
      while (total > have) {
        i++;
        paged.offset = limit * i;
        const r = await this._request(subj, paged) as StreamInfo;
        // update it in case it changed
        total = r.total;
        infos.push(r);
        const count = Object.getOwnPropertyNames(r.state.subjects).length;
        have += count;
        // if request returns less than limit it is done
        if (count < limit) {
          // done
          break;
        }
      }
      // collect all the subjects
      let subjects = {};
      for (let i = 0; i < infos.length; i++) {
        si = infos[i];
        if (si.state.subjects) {
          subjects = Object.assign(subjects, si.state.subjects);
        }
      }
      // don't give the impression we paged
      si.offset = 0;
      si.total = 0;
      si.limit = 0;
      si.state.subjects = subjects;
    }
    this._fixInfo(si);
    return si;
  }

  list(subject = ""): Lister<StreamInfo> {
    const payload = subject?.length ? { subject } : {};
    const listerFilter: ListerFieldFilter<StreamInfo> = (
      v: unknown,
    ): StreamInfo[] => {
      const slr = v as StreamListResponse;
      slr.streams.forEach((si) => {
        this._fixInfo(si);
      });
      return slr.streams;
    };
    const subj = `${this.prefix}.STREAM.LIST`;
    return new ListerImpl<StreamInfo>(subj, listerFilter, this, payload);
  }

  // FIXME: init of sealed, deny_delete, deny_purge shouldn't be necessary
  //  https://github.com/nats-io/nats-server/issues/2633
  _fixInfo(si: StreamInfo) {
    si.config.sealed = si.config.sealed || false;
    si.config.deny_delete = si.config.deny_delete || false;
    si.config.deny_purge = si.config.deny_purge || false;
    si.config.allow_rollup_hdrs = si.config.allow_rollup_hdrs || false;
  }

  async purge(name: string, opts?: PurgeOpts): Promise<PurgeResponse> {
    if (opts) {
      const { keep, seq } = opts as PurgeBySeq & PurgeTrimOpts;
      if (typeof keep === "number" && typeof seq === "number") {
        throw new Error("can specify one of keep or seq");
      }
    }
    validateStreamName(name);
    const v = await this._request(`${this.prefix}.STREAM.PURGE.${name}`, opts);
    return v as PurgeResponse;
  }

  async deleteMessage(
    stream: string,
    seq: number,
    erase = true,
  ): Promise<boolean> {
    validateStreamName(stream);
    const dr = { seq } as MsgDeleteRequest;
    if (!erase) {
      dr.no_erase = true;
    }
    const r = await this._request(
      `${this.prefix}.STREAM.MSG.DELETE.${stream}`,
      dr,
    );
    const cr = r as SuccessResponse;
    return cr.success;
  }

  async getMessage(stream: string, query: MsgRequest): Promise<StoredMsg> {
    validateStreamName(stream);
    const r = await this._request(
      `${this.prefix}.STREAM.MSG.GET.${stream}`,
      query,
    );
    const sm = r as StreamMsgResponse;
    return new StoredMsgImpl(sm);
  }

  find(subject: string): Promise<string> {
    return this.findStream(subject);
  }

  names(subject = ""): Lister<string> {
    const payload = subject?.length ? { subject } : {};
    const listerFilter: ListerFieldFilter<string> = (
      v: unknown,
    ): string[] => {
      const sr = v as StreamNames;
      return sr.streams;
    };
    const subj = `${this.prefix}.STREAM.NAMES`;
    return new ListerImpl<string>(subj, listerFilter, this, payload);
  }

  async get(name: string): Promise<Stream> {
    const si = await this.info(name);
    return Promise.resolve(new StreamImpl(this, si));
  }
}

export class StoredMsgImpl implements StoredMsg {
  _header?: MsgHdrs;
  smr: StreamMsgResponse;
  static jc?: Codec<unknown>;

  constructor(smr: StreamMsgResponse) {
    this.smr = smr;
  }

  get subject(): string {
    return this.smr.message.subject;
  }

  get seq(): number {
    return this.smr.message.seq;
  }

  get timestamp(): string {
    return this.smr.message.time;
  }

  get time(): Date {
    return new Date(Date.parse(this.timestamp));
  }

  get data(): Uint8Array {
    return this.smr.message.data ? this._parse(this.smr.message.data) : Empty;
  }

  get header(): MsgHdrs {
    if (!this._header) {
      if (this.smr.message.hdrs) {
        const hd = this._parse(this.smr.message.hdrs);
        this._header = MsgHdrsImpl.decode(hd);
      } else {
        this._header = headers();
      }
    }
    return this._header;
  }

  _parse(s: string): Uint8Array {
    const bs = atob(s);
    const len = bs.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = bs.charCodeAt(i);
    }
    return bytes;
  }

  json<T = unknown>(reviver?: ReviverFn): T {
    return JSONCodec<T>(reviver).decode(this.data);
  }

  string(): string {
    return TD.decode(this.data);
  }
}

export class StreamsImpl implements Streams {
  api: StreamAPIImpl;

  constructor(api: StreamAPI) {
    this.api = api as StreamAPIImpl;
  }

  get(stream: string): Promise<Stream> {
    return this.api.info(stream)
      .then((si) => {
        return new StreamImpl(this.api, si);
      });
  }
}
