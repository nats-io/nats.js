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

import { BaseApiClientImpl, parseJsResponse } from "./jsbaseclient_api.ts";
import { ConsumerAPIImpl } from "./jsmconsumer_api.ts";

import {
  backoff,
  createInbox,
  deadline,
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
  FastIngest,
  FastIngestOptions,
  FastIngestProgress,
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
  Deferred,
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

    // fail early if watcherPrefix is bad
    try {
      createInbox(opts.watcherPrefix);
    } catch (err) {
      return Promise.reject(err);
    }

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

  startFastIngest(
    subj: string,
    payload?: Payload,
    opts?: Partial<FastIngestOptions>,
  ): Promise<FastIngest> {
    const prefix = opts?.inboxPrefix ?? "_INBOX";
    if (!prefix || /\s/.test(prefix) || /[*>]/.test(prefix)) {
      return Promise.reject(
        new Error(
          `inboxPrefix must be non-empty, no wildcards or whitespace (got "${prefix}")`,
        ),
      );
    }
    const maxOutstandingAcks = Math.min(
      3,
      Math.max(1, opts?.maxOutstandingAcks ?? 2),
    );
    const o: FastIngestOptions = {
      ackInterval: opts?.ackInterval ?? 10,
      gapMode: opts?.gapMode === "fail" ? "fail" : "ok",
      inboxPrefix: prefix,
      maxOutstandingAcks,
    };
    const fi = new FastIngestImpl(this.nc, o, subj, this.timeout);
    return fi.start(payload).then(() => fi);
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
    opts: BatchMessageOptions | BatchMessageOptionsWithReply = { ack: false },
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

const BATCH_CLOSED = "batch closed";

const FastIngestOp = {
  Start: 0,
  Append: 1,
  Final: 2,
  EOB: 3,
  Ping: 4,
} as const;

type FastIngestOpValue = typeof FastIngestOp[keyof typeof FastIngestOp];

type BatchFlowAck = {
  type: "ack";
  seq: number;
  msgs: number;
};

type BatchFlowGap = {
  type: "gap";
  last_seq: number;
  seq: number;
};

type Pending =
  | {
    seq: number;
    op: typeof FastIngestOp.Append | typeof FastIngestOp.Ping;
    deferred: Deferred<FastIngestProgress>;
  }
  | {
    seq: number;
    op: typeof FastIngestOp.Final | typeof FastIngestOp.EOB;
    deferred: Deferred<BatchAck>;
  };

export class FastIngestImpl implements FastIngest {
  readonly batch: string;
  nc: NatsConnection;
  batchSubj: string;
  gapMode: "ok" | "fail";
  initialFlow: number;
  seq: number;
  acked: number;
  ackInterval: number;
  inboxPrefix: string;
  maxOutstandingAcks: number;
  defaultTimeout: number;
  gapIter?: QueuedIteratorImpl<{ lastSeq: number; seq: number }>;
  sub: ReturnType<NatsConnection["subscribe"]>;
  pending: Map<string, Pending>;
  closed: boolean;
  startDeferred: ReturnType<typeof deferred<void>>;
  closedDeferred: ReturnType<typeof deferred<BatchAck>>;

  constructor(
    nc: NatsConnection,
    opts: FastIngestOptions,
    firstSubj: string,
    defaultTimeout: number,
  ) {
    this.nc = nc;
    this.batchSubj = firstSubj;
    this.gapMode = opts.gapMode;
    this.initialFlow = opts.ackInterval;
    this.inboxPrefix = opts.inboxPrefix;
    this.maxOutstandingAcks = opts.maxOutstandingAcks;
    this.defaultTimeout = defaultTimeout;
    this.batch = nuid.next();
    this.seq = 0;
    this.acked = 0;
    this.ackInterval = opts.ackInterval;
    this.pending = new Map();
    this.closed = false;
    this.startDeferred = deferred<void>();
    this.closedDeferred = deferred<BatchAck>();
    // swallow unhandled rejection if caller never attaches to done()
    this.closedDeferred.catch(() => {});
    this.startDeferred.catch(() => {});

    const inbox = `${this.inboxPrefix}.${this.batch}.>`;
    this.sub = this.nc.subscribe(inbox, {
      callback: (err, msg) => this.route(err, msg),
    });
  }

  replyFor(op: FastIngestOpValue, seq: number): string {
    return `${this.inboxPrefix}.${this.batch}.${this.initialFlow}.${this.gapMode}.${seq}.${op}.$FI`;
  }

  start(payload?: Payload): Promise<void> {
    this.seq = 1;
    const rs = this.replyFor(FastIngestOp.Start, 1);
    this.nc.publish(this.batchSubj, payload, { reply: rs });
    return deadline(this.startDeferred, this.defaultTimeout);
  }

  private route(err: Error | null, m: Msg): void {
    if (err) {
      this.close(err);
      return;
    }

    let data: BatchAck | BatchFlowAck;
    try {
      data = parseJsResponse(m) as BatchAck | BatchFlowAck;
    } catch (err) {
      this.close(err as Error);
      return;
    }

    // terminal pub ack (has `batch` field — discriminates from BatchFlowAck)
    if ("batch" in data && typeof data.batch === "string") {
      const ack = data;
      const e = this.pending.get(m.subject);
      if (e && (e.op === FastIngestOp.Final || e.op === FastIngestOp.EOB)) {
        e.deferred.resolve(ack);
        this.pending.delete(m.subject);
      }
      // resolve any stragglers (adds/pings awaiting flow ack) — batch is committed
      for (const [, entry] of this.pending) {
        if (
          entry.op === FastIngestOp.Append ||
          entry.op === FastIngestOp.Ping
        ) {
          entry.deferred.resolve({ batchSeq: entry.seq, ackSeq: this.acked });
        } else {
          entry.deferred.reject(new Error(BATCH_CLOSED));
        }
      }
      this.pending.clear();
      this.resolveStart();
      this.closedDeferred.resolve(ack);
      this.closed = true;
      this.gapIter?.stop();
      this.sub.unsubscribe();
      return;
    }

    const typed = data as { type?: string };

    if (typed.type === "gap") {
      if (this.gapIter) {
        const g = data as unknown as BatchFlowGap;
        this.gapIter.push({ lastSeq: g.last_seq, seq: g.seq });
      }
      return;
    }

    // type:"err" is never reached here — parseJsResponse above throws on the
    // nested `.error` field, which then closes the batch via the outer catch.

    const fa = data as BatchFlowAck;
    if (typeof fa.msgs === "number") this.ackInterval = fa.msgs;
    // cumulative: advance, never regress, so a later ack covers lost earlier ones
    if (typeof fa.seq === "number" && fa.seq > this.acked) {
      this.acked = fa.seq;
    }

    this.resolveStart();

    // exact-subject resolution: ping's flow ack or a blocked add
    const exact = this.pending.get(m.subject);
    if (
      exact &&
      (exact.op === FastIngestOp.Append || exact.op === FastIngestOp.Ping)
    ) {
      exact.deferred.resolve({ batchSeq: exact.seq, ackSeq: this.acked });
      this.pending.delete(m.subject);
    }

    // slide window: any blocked adds now within the allowed window resolve
    for (const [rs, e] of this.pending) {
      if (
        e.op === FastIngestOp.Append &&
        e.seq - this.acked < this.ackInterval * this.maxOutstandingAcks
      ) {
        e.deferred.resolve({ batchSeq: e.seq, ackSeq: this.acked });
        this.pending.delete(rs);
      }
    }
  }

  private resolveStart(): void {
    this.startDeferred.resolve();
  }

  private close(err: Error): void {
    this.closed = true;
    for (const [, e] of this.pending) e.deferred.reject(err);
    this.pending.clear();
    this.startDeferred.reject(err);
    this.closedDeferred.reject(err);
    this.gapIter?.stop();
    this.sub.unsubscribe();
  }

  add(
    subj: string,
    payload?: Payload,
    timeout: number = this.defaultTimeout,
  ): Promise<FastIngestProgress> {
    if (this.closed) return Promise.reject(new Error(BATCH_CLOSED));
    const mySeq = ++this.seq;
    const rs = this.replyFor(FastIngestOp.Append, mySeq);
    this.nc.publish(subj, payload, { reply: rs });

    if (mySeq - this.acked < this.ackInterval * this.maxOutstandingAcks) {
      return Promise.resolve({ batchSeq: mySeq, ackSeq: this.acked });
    }
    const d = deferred<FastIngestProgress>();
    this.pending.set(rs, { seq: mySeq, op: FastIngestOp.Append, deferred: d });
    return deadline(d, timeout);
  }

  last(
    subj: string,
    payload?: Payload,
    timeout: number = this.defaultTimeout,
  ): Promise<BatchAck> {
    if (this.closed) return Promise.reject(new Error(BATCH_CLOSED));
    const mySeq = ++this.seq;
    const rs = this.replyFor(FastIngestOp.Final, mySeq);
    const d = deferred<BatchAck>();
    this.pending.set(rs, { seq: mySeq, op: FastIngestOp.Final, deferred: d });
    this.nc.publish(subj, payload, { reply: rs });
    return deadline(d, timeout);
  }

  end(timeout: number = this.defaultTimeout): Promise<BatchAck> {
    if (this.closed) return Promise.reject(new Error(BATCH_CLOSED));
    const mySeq = ++this.seq;
    const rs = this.replyFor(FastIngestOp.EOB, mySeq);
    const d = deferred<BatchAck>();
    this.pending.set(rs, { seq: mySeq, op: FastIngestOp.EOB, deferred: d });
    this.nc.publish(this.batchSubj, Empty, { reply: rs });
    return deadline(d, timeout);
  }

  ping(timeout: number = this.defaultTimeout): Promise<FastIngestProgress> {
    if (this.closed) return Promise.reject(new Error(BATCH_CLOSED));
    const rs = this.replyFor(FastIngestOp.Ping, this.seq);
    // coalesce concurrent pings on same seq — same reply subject, one server ack
    const existing = this.pending.get(rs);
    if (existing && existing.op === FastIngestOp.Ping) {
      return deadline(existing.deferred, timeout);
    }
    const d = deferred<FastIngestProgress>();
    this.pending.set(rs, { seq: this.seq, op: FastIngestOp.Ping, deferred: d });
    this.nc.publish(this.batchSubj, Empty, { reply: rs });
    return deadline(d, timeout);
  }

  done(): Promise<BatchAck> {
    return this.closedDeferred;
  }

  gaps(): AsyncIterable<{ lastSeq: number; seq: number }> {
    if (!this.gapIter) {
      this.gapIter = new QueuedIteratorImpl();
    }
    return this.gapIter;
  }
}
