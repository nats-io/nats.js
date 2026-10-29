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

import { BaseApiClientImpl } from "./jsbaseclient_api.ts";
import type {
  ConsumerNotification,
  DirectMsg,
  DirectStreamAPI,
  JetStreamOptions,
  MaxBytes,
  StoredMsg,
} from "./types.ts";
import { DirectMsgHeaders } from "./types.ts";
import type {
  CallbackFn,
  Deferred,
  Delay,
  Msg,
  MsgHdrs,
  NatsConnection,
  QueuedIterator,
  ReviverFn,
  SentinelFn,
} from "@nats-io/nats-core/internal";
import {
  deferred,
  delay,
  Empty,
  Feature,
  NoRespondersError,
  QueuedIteratorImpl,
  TD,
  TimeoutError,
} from "@nats-io/nats-core/internal";
import type {
  CompletionResult,
  DirectBatch,
  DirectBatchOptions,
  DirectBatchStartSeq,
  DirectBatchStartTime,
  DirectLastFor,
  DirectMaxBytes,
  DirectMsgRequest,
  LastForMsgRequest,
  PullOptions,
} from "./jsapi_types.ts";
import { validateStreamName } from "./jsutil.ts";
import { JetStreamStatus, JetStreamStatusError } from "./jserrors.ts";

export class DirectStreamAPIImpl extends BaseApiClientImpl
  implements DirectStreamAPI {
  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    super(nc, opts);
  }

  async getMessage(
    stream: string,
    query: DirectMsgRequest,
  ): Promise<StoredMsg | null> {
    validateStreamName(stream);

    if ("start_time" in query) {
      const { min, ok } = this.nc.features.get(Feature.JS_BATCH_DIRECT_GET);
      if (!ok) {
        throw new Error(`start_time direct option require server ${min}`);
      }
    }

    // if doing a last_by_subj request, we append the subject
    // this allows last_by_subj to be subject to permissions (KV)
    let qq: DirectMsgRequest | null = query;
    const { last_by_subj } = qq as LastForMsgRequest;
    if (last_by_subj) {
      qq = null;
    }

    const payload = qq ? JSON.stringify(qq) : Empty;
    const pre = this.opts.apiPrefix || "$JS.API";
    const subj = last_by_subj
      ? `${pre}.DIRECT.GET.${stream}.${last_by_subj}`
      : `${pre}.DIRECT.GET.${stream}`;

    const r = await this.nc.request(
      subj,
      payload,
      { timeout: this.timeout },
    );

    if (r.headers?.code !== 0) {
      const status = new JetStreamStatus(r);
      if (status.isMessageNotFound()) {
        return Promise.resolve(null);
      } else {
        return Promise.reject(status.toError());
      }
    }

    const dm = new DirectMsgImpl(r);
    return Promise.resolve(dm);
  }

  getBatch(
    stream: string,
    opts: DirectBatchOptions,
  ): Promise<QueuedIterator<StoredMsg>> {
    return this.get(stream, { ...opts, batch: opts.batch || 1024 });
  }

  getLastMessagesFor(
    stream: string,
    opts: DirectLastFor,
  ): Promise<QueuedIterator<StoredMsg>> {
    return this.get(stream, opts);
  }

  get(
    stream: string,
    opts: DirectBatchOptions | DirectLastFor,
  ): Promise<QueuedIterator<StoredMsg>> {
    // the timeout and callback are for the client, not part of the request
    const { timeout, callback: cb, ...req } = opts;
    const { min, ok } = this.nc.features.get(Feature.JS_BATCH_DIRECT_GET);
    if (!ok) {
      return Promise.reject(new Error(`batch direct require server ${min}`));
    }
    validateStreamName(stream);
    const callback = typeof cb === "function" ? cb : null;
    const iter = new QueuedIteratorImpl<StoredMsg>();

    function pushIter(
      done: CompletionResult | null,
      d: StoredMsg | CallbackFn,
    ) {
      if (done) {
        iter.push(() => {
          done.err ? iter.stop(done.err) : iter.stop();
        });
        return;
      }
      iter.push(d);
    }

    function pushCb(
      done: CompletionResult | null,
      m: StoredMsg | CallbackFn,
    ) {
      const cb = callback!;
      if (typeof m === "function") {
        m();
        return;
      }
      cb(done, m);
    }

    const push = callback ? pushCb : pushIter;

    // the batch is complete when the server says so - end of batch, no
    // results, or a single reply when no batch was requested
    let complete = false;
    let batchSupported = false;
    const strategy: SentinelFn = (msg) => {
      const status = JetStreamStatus.maybeParseStatus(msg);
      if (status) {
        if (status.isEndOfBatch() || status.isNoResults()) {
          complete = true;
          return false;
        }
        return status.toError();
      }
      if (!batchSupported) {
        if (!msg.headers?.has("Nats-Num-Pending")) {
          // no batch/max_bytes option was provided, so single response
          complete = true;
          return false;
        }
        batchSupported = true;
      }
      return true;
    };

    const pre = this.opts.apiPrefix || "$JS.API";
    const subj = `${pre}.DIRECT.GET.${stream}`;

    const payload = JSON.stringify(req, (key, value) => {
      if (
        (key === "up_to_time" || key === "start_time") && value instanceof Date
      ) {
        return value.toISOString();
      }
      return value;
    });

    // each reply must arrive within the timeout: the first (timeout), and
    // every one after it (stall). a batch that keeps flowing is never cut
    // short, so there's no upper bound.
    const ms = timeout || this.timeout;
    // created here so its stack is the caller's
    const stalled = new TimeoutError();
    return this.nc.requestMany(subj, payload, {
      strategy,
      timeout: ms,
      stall: ms,
      maxWait: Infinity,
    }).then((replies) => {
      iter.iterClosed.then((err) => {
        replies.stop();
        if (callback) {
          push({ err: err ? err : undefined }, {} as StoredMsg);
        }
      });

      (async () => {
        for await (const m of replies) {
          // stopped by the user, possibly from the callback - nothing
          // is delivered after that
          if (iter.done) {
            break;
          }
          // status replies end the batch, they are not messages
          if (!JetStreamStatus.maybeParseStatus(m)) {
            push(null, new DirectMsgImpl(m));
          }
        }
        // the replies stopped before the batch completed
        if (!complete && !iter.done) {
          throw stalled;
        }
      })().then(() => {
        push({}, () => {
          iter.stop();
        });
      }).catch((err) => {
        push({ err }, () => {
          iter.stop(err);
        });
      });

      return iter;
    });
  }
}

export class DirectMsgImpl implements DirectMsg {
  data: Uint8Array;
  header: MsgHdrs;

  constructor(m: Msg) {
    if (!m.headers) {
      throw new Error("headers expected");
    }
    this.data = m.data;
    this.header = m.headers;
  }

  get subject(): string {
    return this.header.last(DirectMsgHeaders.Subject);
  }

  get seq(): number {
    const v = this.header.last(DirectMsgHeaders.Sequence);
    return typeof v === "string" ? parseInt(v) : 0;
  }

  get time(): Date {
    return new Date(Date.parse(this.timestamp));
  }

  get timestamp(): string {
    return this.header.last(DirectMsgHeaders.TimeStamp);
  }

  get stream(): string {
    return this.header.last(DirectMsgHeaders.Stream);
  }

  get lastSequence(): number {
    const v = this.header.last(DirectMsgHeaders.LastSequence);
    return typeof v === "string" ? parseInt(v) : 0;
  }

  get pending(): number {
    const v = this.header.last(DirectMsgHeaders.NumPending);
    // pre-2.12, we reduced the count by 1, as the server reported
    // the eod message
    return typeof v === "string" ? parseInt(v) : -1;
  }

  json<T = unknown>(reviver?: ReviverFn): T {
    return JSON.parse(new TextDecoder().decode(this.data), reviver);
  }

  string(): string {
    return TD.decode(this.data);
  }
}

/**
 * Options for directly starting a direct consumer. The options can either specify
 * a sequence start or a time start.
 * @property {DirectBatchStartSeq} DirectBatchStartSeq - Specifies a sequence start for the consumer.
 * @property {DirectBatchStartTime} DirectBatchStartTime - Specifies a time start for the consumer.
 */
export type DirectStartOptions = DirectBatchStartSeq | DirectBatchStartTime;

/**
 * Represents the limits for the operation. For fetch requests it represents the maximum to be retrieved.
 * For consume operations it represents the buffering for the consumer.
 *
 * This type is used to define constraints or configurations for batching processes that
 * operate under specific limits, either in terms of quantity (DirectBatch) or size in bytes (DirectMaxBytes).
 */
export type DirectBatchLimits = DirectBatch | DirectMaxBytes;

function isDirectBatchStartTime(
  t: DirectStartOptions,
): t is DirectBatchStartTime {
  return typeof t === "object" && "start_time" in t;
}

function isMaxBytes(t: DirectBatchLimits): t is MaxBytes {
  return typeof t === "object" && "max_bytes" in t;
}

export class DirectConsumer {
  stream: string;
  api: DirectStreamAPIImpl;
  cursor: { last: number; pending?: number };
  listeners: QueuedIteratorImpl<ConsumerNotification>[];
  start: DirectStartOptions;

  constructor(
    stream: string,
    api: DirectStreamAPIImpl,
    start: DirectStartOptions,
  ) {
    this.stream = stream;
    this.api = api;
    this.cursor = { last: 0 };
    this.listeners = [];
    this.start = start;
  }

  getOptions(
    opts?: DirectBatchLimits,
  ): DirectBatchOptions {
    opts = opts || {} as DirectBatchLimits;
    const dbo: Partial<DirectBatchOptions> = {};

    if (this.cursor.last === 0) {
      // we have never pulled, honor initial request options
      if (isDirectBatchStartTime(this.start)) {
        dbo.start_time = this.start.start_time!;
      } else {
        dbo.seq = this.start.seq || 1;
      }
    } else {
      dbo.seq = this.cursor.last + 1;
    }

    if (isMaxBytes(opts)) {
      dbo.max_bytes = opts.max_bytes;
    } else {
      dbo.batch = opts.batch ?? 100;
    }

    return dbo as DirectBatchOptions;
  }

  status(): AsyncIterable<ConsumerNotification> {
    const iter = new QueuedIteratorImpl<ConsumerNotification>();
    this.listeners.push(iter);
    return iter;
  }

  notify(n: ConsumerNotification): void {
    if (this.listeners.length > 0) {
      (() => {
        const remove: QueuedIteratorImpl<ConsumerNotification>[] = [];
        this.listeners.forEach((l) => {
          const qi = l as QueuedIteratorImpl<ConsumerNotification>;
          if (!qi.done) {
            qi.push(n);
          } else {
            remove.push(qi);
          }
        });
        this.listeners = this.listeners.filter((l) => !remove.includes(l));
      })();
    }
  }

  debug() {
    console.log(this.cursor);
  }

  consume(opts: DirectBatchLimits): Promise<QueuedIterator<StoredMsg>> {
    let pending: Delay | undefined;
    let requestDone: Deferred<void> | undefined;
    let src: QueuedIteratorImpl<StoredMsg> | undefined;
    const qi = new QueuedIteratorImpl<StoredMsg>();

    // stopping ends the current pull or sleep
    qi.iterClosed.then(() => {
      src?.stop();
      pending?.cancel();
      requestDone?.resolve();
    });

    (async () => {
      // set when the last pull failed or delivered nothing, so we don't
      // retry in a tight loop (errors, an empty stream)
      let idle = false;
      while (true) {
        // if caught up or idle, slow it down
        // on the first pull pending doesn't exist so no delay
        if (this.cursor.pending === 0 || idle) {
          this.notify({
            type: "debug",
            code: 0,
            description: "sleeping for 2500",
          });
          pending = delay(2500);
          await pending;
        }
        // check that we are still supposed to be running
        // pending could have released if the iter closed
        if (qi.done) {
          break;
        }
        const done = deferred<void>();
        requestDone = done;
        let delivered = 0;
        let failed = false;
        let reset = false;
        const dbo = this.getOptions(opts);
        this.notify({
          type: "next",
          options: Object.assign({}, opts) as PullOptions,
        });

        dbo.callback = (r: CompletionResult | null, sm: StoredMsg): void => {
          if (r) {
            // if the current fetch is done, ready to schedule the next
            if (r.err) {
              failed = true;
              if (r.err instanceof JetStreamStatusError) {
                this.notify({
                  type: "debug",
                  code: r.err.code,
                  description: r.err.message,
                });
              } else if (r.err instanceof NoRespondersError) {
                this.notify({
                  type: "debug",
                  code: 503,
                  description: r.err.message,
                });
              } else {
                this.notify({
                  type: "debug",
                  code: 0,
                  description: r.err.message,
                });
              }
            }
            done.resolve();
          } else if (
            sm.lastSequence > 0 && sm.lastSequence !== this.cursor.last
          ) {
            // need to reset
            reset = true;
            src?.stop();
            done.resolve();
            this.notify({
              type: "reset",
              name: "direct",
            });
          } else {
            delivered++;
            qi.push(sm);
            qi.received++;
            this.cursor.last = sm.seq;
            this.cursor.pending = sm.pending;
          }
        };

        try {
          src = await this.api.getBatch(
            this.stream,
            dbo,
          ) as QueuedIteratorImpl<StoredMsg>;
        } catch (err) {
          // the request couldn't be made (closed connection, etc)
          qi.stop(err as Error);
          break;
        }
        if (qi.done) {
          src.stop();
          break;
        }

        await done;
        // a reset pulls again right away
        idle = !reset && (failed || delivered === 0);
      }
    })().catch((err) => {
      qi.stop(err);
    });

    return Promise.resolve(qi);
  }

  async fetch(opts?: DirectBatchLimits): Promise<QueuedIterator<StoredMsg>> {
    const dbo = this.getOptions(opts);
    const qi = new QueuedIteratorImpl<StoredMsg>();
    const src = await this.api.get(
      this.stream,
      Object.assign({
        callback: (done: CompletionResult | null, sm: StoredMsg) => {
          if (done) {
            // the server sent error or is done, we are done
            qi.push(() => {
              done.err ? qi.stop(done.err) : qi.stop();
            });
          } else if (
            sm.lastSequence > 0 && sm.lastSequence !== this.cursor.last
          ) {
            // we are done early because the sequence jumped unexpectedly
            qi.push(() => {
              qi.stop();
            });
            src.stop();
          } else {
            // pass-through to client, and record
            qi.push(sm);
            qi.received++;
            this.cursor.last = sm.seq;
            this.cursor.pending = sm.pending;
          }
        },
      }, dbo),
    );
    qi.iterClosed.then(() => {
      src.stop();
    });

    return qi;
  }

  async next(): Promise<StoredMsg | null> {
    const sm = await this.api.getMessage(this.stream, {
      seq: this.cursor.last + 1,
    });
    const seq = sm?.seq;
    if (seq) {
      this.cursor.last = seq;
    }
    return sm;
  }
}
