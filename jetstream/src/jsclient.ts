/*
 * Copyright 2022-2024 The NATS Authors
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

import { BaseApiClientImpl } from "./jsbaseclient_api.ts";
import { ConsumerAPIImpl } from "./jsmconsumer_api.ts";

import {
  backoff,
  deferred,
  delay,
  Empty,
  errors,
  headers,
  nuid,
  QueuedIteratorImpl,
  RequestError,
} from "@nats-io/nats-core/internal";

import { ConsumersImpl, StreamAPIImpl, StreamsImpl } from "./jsmstream_api.ts";

import type {
  Advisory,
  AdvisoryKind,
  Batch,
  BatchAck,
  BatchMessageOptions,
  BatchMessageOptionsWithReply,
  ConsumerAPI,
  Consumers,
  DirectStreamAPI,
  JetStreamClient,
  JetStreamManager,
  JetStreamManagerOptions,
  JetStreamOptions,
  JetStreamPublishOptions,
  PubAck,
  StreamAPI,
  Streams,
} from "./types.ts";

import type {
  Msg,
  NatsConnection,
  Payload,
  RequestOptions,
} from "@nats-io/nats-core/internal";
import { PubHeaders } from "./jsapi_types.ts";
import type {
  AccountInfoResponse,
  ApiResponse,
  JetStreamAccountStats,
} from "./jsapi_types.ts";
import { JetStreamError, JetStreamNotEnabled } from "./jserrors.ts";
import { DirectStreamAPIImpl } from "./jsm_direct.ts";

export function toJetStreamClient(
  nc: NatsConnection | JetStreamClient,
): JetStreamClient {
  //@ts-ignore: see if we have a nc
  if (typeof nc.nc === "undefined") {
    return jetstream(nc as NatsConnection);
  }
  return nc as JetStreamClient;
}

/**
 * Returns a {@link JetStreamClient} supported by the specified NatsConnection
 * @param nc
 * @param opts
 */
export function jetstream(
  nc: NatsConnection,
  opts: JetStreamManagerOptions = {},
): JetStreamClient {
  return new JetStreamClientImpl(nc, opts);
}

/**
 * Returns a {@link JetStreamManager} supported by the specified NatsConnection
 * @param nc
 * @param opts
 */
export async function jetstreamManager(
  nc: NatsConnection,
  opts: JetStreamOptions | JetStreamManagerOptions = {},
): Promise<JetStreamManager> {
  const adm = new JetStreamManagerImpl(nc, opts);
  if ((opts as JetStreamManagerOptions).checkAPI !== false) {
    try {
      await adm.getAccountInfo();
    } catch (err) {
      throw err;
    }
  }
  return adm;
}

export class JetStreamManagerImpl extends BaseApiClientImpl
  implements JetStreamManager {
  streams: StreamAPI;
  consumers: ConsumerAPI;
  direct: DirectStreamAPI;

  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    super(nc, opts);
    this.streams = new StreamAPIImpl(nc, opts);
    this.consumers = new ConsumerAPIImpl(nc, opts);
    this.direct = new DirectStreamAPIImpl(nc, opts);
  }

  async getAccountInfo(): Promise<JetStreamAccountStats> {
    const r = await this._request(`${this.prefix}.INFO`);
    return r as AccountInfoResponse;
  }

  jetstream(): JetStreamClient {
    return jetstream(this.nc, this.getOptions());
  }

  advisories(): AsyncIterable<Advisory> {
    const iter = new QueuedIteratorImpl<Advisory>();
    this.nc.subscribe(`$JS.EVENT.ADVISORY.>`, {
      callback: (err, msg) => {
        if (err) {
          throw err;
        }
        try {
          const d = this.parseJsResponse(msg) as ApiResponse;
          const chunks = d.type.split(".");
          const kind = chunks[chunks.length - 1];
          iter.push({ kind: kind as AdvisoryKind, data: d });
        } catch (err) {
          iter.stop(err as Error);
        }
      },
    });

    return iter;
  }
}

export class JetStreamClientImpl extends BaseApiClientImpl
  implements JetStreamClient {
  consumers: Consumers;
  streams: Streams;
  consumerAPI: ConsumerAPI;
  streamAPI: StreamAPIImpl;
  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    super(nc, opts);
    this.consumerAPI = new ConsumerAPIImpl(nc, opts);
    this.streamAPI = new StreamAPIImpl(nc, opts);
    this.consumers = new ConsumersImpl(this.consumerAPI);
    this.streams = new StreamsImpl(this.streamAPI);
  }

  jetstreamManager(checkAPI?: boolean): Promise<JetStreamManager> {
    if (checkAPI === undefined) {
      checkAPI = (this.opts as JetStreamManagerOptions).checkAPI;
    }
    const opts = Object.assign(
      {},
      this.opts,
      { checkAPI },
    ) as JetStreamManagerOptions;
    return jetstreamManager(this.nc, opts);
  }

  get apiPrefix(): string {
    return this.prefix;
  }

  startBatch(
    subj: string,
    payload?: Payload,
    opts?: Partial<JetStreamPublishOptions>,
  ): Promise<Batch> {
    const d = deferred<Batch>();
    const bp = new BatchPublisherImpl(this);
    bp.first(subj, payload, opts)
      .then(() => {
        d.resolve(bp);
      })
      .catch((err: Error) => {
        d.reject(err);
      });

    return d;
  }

  async _publish(
    subj: string,
    data: Payload = Empty,
    opts?: Partial<JetStreamPublishOptions>,
  ): Promise<Msg> {
    opts = opts || {};
    opts = { ...opts };
    opts.expect = opts.expect || {};
    const mh = opts?.headers || headers();
    if (opts) {
      if (opts.msgID) {
        mh.set(PubHeaders.MsgIdHdr, opts.msgID);
      }
      if (opts.expect.lastMsgID) {
        mh.set(PubHeaders.ExpectedLastMsgIdHdr, opts.expect.lastMsgID);
      }
      if (opts.expect.streamName) {
        mh.set(PubHeaders.ExpectedStreamHdr, opts.expect.streamName);
      }
      if (typeof opts.expect.lastSequence === "number") {
        mh.set(PubHeaders.ExpectedLastSeqHdr, `${opts.expect.lastSequence}`);
      }
      if (typeof opts.expect.lastSubjectSequence === "number") {
        mh.set(
          PubHeaders.ExpectedLastSubjectSequenceHdr,
          `${opts.expect.lastSubjectSequence}`,
        );
      }
      if (opts.expect.lastSubjectSequenceSubject) {
        mh.set(
          PubHeaders.ExpectedLastSubjectSequenceSubjectHdr,
          opts.expect.lastSubjectSequenceSubject,
        );
      }
      if (opts.ttl) {
        mh.set(
          PubHeaders.MessageTTL,
          `${opts.ttl}`,
        );
      }

      if (opts.schedule) {
        const so = opts.schedule;
        if (so.specification) {
          if (typeof so.specification === "string") {
            mh.set(PubHeaders.Schedule, so.specification);
          } else if (so.specification instanceof Date) {
            mh.set(
              PubHeaders.Schedule,
              "@at " + so.specification.toISOString(),
            );
          }
        }
        if (so.target) {
          mh.set(PubHeaders.ScheduleTarget, so.target);
        }
        if (so.source) {
          mh.set(PubHeaders.ScheduleSource, so.source);
        }
        if (so.ttl) {
          mh.set(PubHeaders.ScheduleTTL, so.ttl);
        }
      }
    }

    const to = opts.timeout || this.timeout;
    const ro = {} as RequestOptions;
    if (to) {
      ro.timeout = to;
    }
    if (opts) {
      ro.headers = mh;
    }

    let { retries } = opts as {
      retries: number;
    };
    retries = retries || 1;
    const bo = backoff();

    let r: Msg | null = null;
    for (let i = 0; i < retries; i++) {
      try {
        r = await this.nc.request(subj, data, ro);
        // if here we succeeded
        break;
      } catch (err) {
        const re = err instanceof RequestError ? err as RequestError : null;
        if (
          (err instanceof errors.TimeoutError || re?.isNoResponders()) &&
          i + 1 < retries
        ) {
          await delay(bo.backoff(i));
        } else {
          throw re?.isNoResponders()
            ? new JetStreamNotEnabled(`jetstream is not enabled`, {
              cause: err,
            })
            : err;
        }
      }
    }
    return r!;
  }

  async publish(
    subj: string,
    data: Payload = Empty,
    opts?: Partial<JetStreamPublishOptions>,
  ): Promise<PubAck> {
    const r = await this._publish(subj, data, opts);
    const pa = this.parseJsResponse(r) as PubAck;
    if (pa.stream === "") {
      throw new JetStreamError("invalid ack response");
    }
    pa.duplicate = pa.duplicate ? pa.duplicate : false;
    return pa;
  }
}

export class BatchPublisherImpl implements Batch {
  nc: NatsConnection;
  js: JetStreamClientImpl;
  readonly id: string;
  count: number;
  done: boolean;
  constructor(js: JetStreamClient) {
    this.count = 0;
    this.id = nuid.next();
    this.js = js as JetStreamClientImpl;
    this.nc = this.js.nc;
    this.done = false;
  }

  async first(
    subj: string,
    payload?: Payload,
    opts?: Partial<JetStreamPublishOptions>,
  ): Promise<void> {
    opts = opts || {};
    opts.headers = opts?.headers || headers();
    opts.headers.set("Nats-Batch-Id", this.id);
    this.count++;
    opts.headers.set("Nats-Batch-Sequence", this.count.toString());

    const r = await this.js._publish(subj, payload, opts);
    if (r.data.length > 0) {
      this.js.parseJsResponse(r);
    }
  }

  add(subj: string, payload?: Payload, opts?: BatchMessageOptions): void;
  add(
    subj: string,
    payload?: Payload,
    opts?: BatchMessageOptionsWithReply,
  ): Promise<void>;
  add(
    subj: string,
    payload?: Payload,
    opts: BatchMessageOptions | BatchMessageOptionsWithReply = {},
  ): void | Promise<void> {
    if (this.done) {
      throw new Error("batch publisher is done");
    }
    opts.headers = opts?.headers || headers();
    opts.headers.set("Nats-Batch-Id", this.id);
    this.count++;
    opts.headers.set("Nats-Batch-Sequence", this.count.toString());

    const hasAck = "ack" in opts && opts.ack === true;
    if (hasAck) {
      const d = deferred<void>();
      this.js._publish(subj, payload, {
        headers: opts.headers,
        timeout: (opts as BatchMessageOptionsWithReply).timeout,
      }).then((m) => {
        if (m.data.length > 0) {
          this.js.parseJsResponse(m);
        }
        d.resolve();
      }).catch((err) => {
        this.done = true;
        d.reject(err);
      });
      return d;
    } else {
      return this.nc.publish(subj, payload, { headers: opts.headers });
    }
  }

  async commit(
    subj: string,
    payload?: Payload,
    opts: Partial<RequestOptions> = {},
  ): Promise<BatchAck> {
    if (this.done) {
      throw new Error("batch publisher is done");
    } else {
      this.done = true;
    }

    opts.headers = opts?.headers || headers();
    opts.headers.set("Nats-Batch-Id", this.id);
    this.count++;
    opts.headers.set("Nats-Batch-Sequence", this.count.toString());
    opts.headers.set("Nats-Batch-Commit", "1");

    const r = await this.js._publish(subj, payload, {
      headers: opts.headers,
      timeout: opts.timeout || 0,
    });

    const ack = r.json<BatchAck>();
    if (ack.count !== this.count) {
      throw new Error("batch didn't contain number of published messages");
    }
    return ack;
  }
}
