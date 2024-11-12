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

import type {
  CallbackFn,
  Delay,
  MsgImpl,
  QueuedIterator,
  Status,
  Subscription,
  SubscriptionImpl,
  Timeout,
} from "@nats-io/nats-core/internal";
import {
  backoff,
  createInbox,
  delay,
  errors,
  Feature,
  IdleHeartbeatMonitor,
  nanos,
  nuid,
  QueuedIteratorImpl,
  timeout,
} from "@nats-io/nats-core/internal";
import type { ConsumerAPIImpl } from "./jsmconsumer_api.ts";

import type { JsMsg } from "./jsmsg.ts";
import { toJsMsg } from "./jsmsg.ts";

import type {
  ConsumerConfig,
  ConsumerInfo,
  OverflowMinPendingAndMinAck,
  PullOptions,
} from "./jsapi_types.ts";
import { AckPolicy, DeliverPolicy } from "./jsapi_types.ts";
import type {
  ConsumeMessages,
  ConsumeOptions,
  Consumer,
  ConsumerAPI,
  ConsumerCallbackFn,
  ConsumerMessages,
  ConsumerStatus,
  Expires,
  FetchMessages,
  FetchOptions,
  IdleHeartbeat,
  MaxBytes,
  MaxMessages,
  NextOptions,
  OrderedConsumerOptions,
  PullConsumerOptions,
  ThresholdBytes,
  ThresholdMessages,
} from "./types.ts";
import { ConsumerDebugEvents, ConsumerEvents } from "./types.ts";
import { JetStreamStatus } from "./jserrors.ts";
import { minValidation } from "./jsutil.ts";

enum PullConsumerType {
  Unset = -1,
  Consume,
  Fetch,
}

export type OrderedConsumerState = {
  namePrefix: string;
  cursor: { stream_seq: number; deliver_seq: number };
  type: PullConsumerType;
  startSeq: number;
  maxInitialReset: number;
  opts: Partial<OrderedConsumerOptions>;
  createFails: number;
  needsReset?: boolean;
};

export type PullConsumerInternalOptions = {
  refilling: boolean;
  ordered?: OrderedConsumerOptions;
};

type InternalPullOptions =
  & MaxMessages
  & MaxBytes
  & Expires
  & IdleHeartbeat
  & ThresholdMessages
  & OverflowMinPendingAndMinAck
  & ThresholdBytes;

export function isOverflowOptions(
  opts: unknown,
): opts is OverflowMinPendingAndMinAck {
  const oo = opts as OverflowMinPendingAndMinAck;
  return oo && typeof oo.group === "string" ||
    typeof oo.min_pending === "number" ||
    typeof oo.min_ack_pending === "number";
}

export class PullConsumerMessagesImpl extends QueuedIteratorImpl<JsMsg>
  implements ConsumerMessages {
  consumer: PullConsumerImpl;
  opts: InternalPullOptions;
  sub!: Subscription;
  monitor: IdleHeartbeatMonitor | null;
  pending: { msgs: number; bytes: number; requests: number };
  isConsume: boolean;
  callback: ConsumerCallbackFn | null;
  timeout: Timeout<unknown> | null;
  listeners: QueuedIterator<ConsumerStatus>[];
  statusIterator?: QueuedIteratorImpl<Status>;
  abortOnMissingResource?: boolean;
  bind: boolean;
  inboxPrefix: string;
  inbox!: string;
  cancelables: Delay[];

  // callback: ConsumerCallbackFn;
  constructor(
    c: PullConsumerImpl,
    opts: ConsumeOptions | FetchOptions,
    refilling = false,
  ) {
    super();
    this.consumer = c;
    this.isConsume = refilling;
    this.cancelables = [];
    this.inboxPrefix = createInbox(this.consumer.api.nc.options.inboxPrefix);
    this.inbox = `${this.inboxPrefix}.${this.consumer.serial}`;

    if (this.consumer.ordered) {
      if (isOverflowOptions(opts)) {
        throw errors.InvalidArgumentError.format([
          "group",
          "min_pending",
          "min_ack_pending",
        ], "cannot be specified for ordered consumers");
      }
      if (this.consumer.orderedConsumerState === undefined) {
        // initialize the state for the order consumer
        const ocs = {} as OrderedConsumerState;
        const iopts = c.opts;
        ocs.namePrefix = iopts.name_prefix ?? `oc_${nuid.next()}`;
        ocs.opts = iopts;
        ocs.cursor = { stream_seq: 1, deliver_seq: 0 };
        const startSeq = c._info.config.opt_start_seq || 0;
        ocs.cursor.stream_seq = startSeq > 0 ? startSeq - 1 : 0;
        ocs.createFails = 0;
        this.consumer.orderedConsumerState = ocs;
      }
    }

    const copts = opts as ConsumeOptions;
    this.opts = this.parseOptions(opts, this.isConsume);
    this.callback = copts.callback || null;
    this.noIterator = typeof this.callback === "function";
    this.monitor = null;
    this.pending = { msgs: 0, bytes: 0, requests: 0 };
    this.timeout = null;
    this.listeners = [];
    this.abortOnMissingResource = copts.abort_on_missing_resource === true;
    this.bind = copts.bind === true;

    this.start();
  }

  start(): void {
    const {
      max_messages,
      max_bytes,
      idle_heartbeat,
      threshold_bytes,
      threshold_messages,
    } = this.opts;

    this.sub = this.consumer.api.nc.subscribe(this.inbox, {
      callback: (err, msg) => {
        if (err) {
          // this is possibly only a permissions error which means
          // that the server rejected (eliminating the sub)
          // or the client never had permissions to begin with
          // so this is terminal
          this.stop(err);
          return;
        }
        this.monitor?.work();

        const isProtocol = this.consumer.ordered
          ? msg.subject.indexOf(this?.inboxPrefix!) === 0
          : msg.subject === this.inbox;

        if (isProtocol) {
          if (msg.subject !== (this.sub as SubscriptionImpl).subject) {
            // this is a stale message - was not sent to the current inbox
            return;
          }
          const status = new JetStreamStatus(msg);

          if (status.isIdleHeartbeat()) {
            this.notify(ConsumerDebugEvents.Heartbeat, status.parseHeartbeat());
            return;
          }
          const code = status.code;
          const description = status.description;

          const { msgsLeft, bytesLeft } = status.parseDiscard();
          if ((msgsLeft && msgsLeft > 0) || (bytesLeft && bytesLeft > 0)) {
            this.pending.msgs -= msgsLeft;
            this.pending.bytes -= bytesLeft;
            this.pending.requests--;
            this.notify(ConsumerDebugEvents.Discard, { msgsLeft, bytesLeft });
          } else {
            // Examine the error codes
            // FIXME: 408 can be a Timeout or bad request,
            //  or it can be sent if a nowait request was
            //  sent when other waiting requests are pending
            //  "Requests Pending"

            // FIXME: 400 bad request Invalid Heartbeat or Unmarshalling Fails
            //  these are real bad values - so this is bad request
            //  fail on this
            // we got a bad request - no progress here
            switch (code) {
              case 400:
                this.stop(status.toError());
                return;
              case 409: {
                const err = this.handle409(status);
                if (err) {
                  this.stop(err);
                  return;
                }
                // stall, missed heartbeats will resuscitate
                // proportionally to 2 missed heartbeats
                break;
              }
              default:
                this.notify(
                  ConsumerDebugEvents.DebugEvent,
                  { code, description },
                );
            }
          }
        } else {
          // convert to JsMsg
          const m = toJsMsg(msg, this.consumer.api.timeout);
          // if we are ordered, check
          if (this.consumer.ordered) {
            const cursor = this.consumer.orderedConsumerState!.cursor;
            const dseq = m.info.deliverySequence;
            const sseq = m.info.streamSequence;
            const expected_dseq = cursor.deliver_seq + 1;
            if (
              dseq !== expected_dseq
            ) {
              // got a message out of order, have to recreate
              this.reset();
              return;
            }
            // update the state
            cursor.deliver_seq = dseq;
            cursor.stream_seq = sseq;
          }
          // yield the message
          this._push(m);
          this.received++;
          if (this.pending.msgs) {
            this.pending.msgs--;
          }
          if (this.pending.bytes) {
            this.pending.bytes -= (msg as MsgImpl).size();
          }
        }

        // if we don't have pending bytes/messages we are done or starving
        if (this.pending.msgs === 0 && this.pending.bytes === 0) {
          this.pending.requests = 0;
        }
        if (this.isConsume) {
          // FIXME: this could result in  1/4 = 0
          if (
            (max_messages && this.pending.msgs <= threshold_messages) ||
            (max_bytes && this.pending.bytes <= threshold_bytes)
          ) {
            const batch = this.pullOptions();
            // @ts-ignore: we are pushing the pull fn
            this.pull(batch);
          }
        } else if (this.pending.requests === 0) {
          // @ts-ignore: we are pushing the pull fn
          this._push(() => {
            this.stop();
          });
        }
      },
    });

    this.sub.closed.then(() => {
      // for ordered consumer we cannot break the iterator
      if ((this.sub as SubscriptionImpl).draining) {
        // @ts-ignore: we are pushing the pull fn
        this._push(() => {
          this.stop();
        });
      }
    });

    if (idle_heartbeat) {
      this.monitor = new IdleHeartbeatMonitor(
        idle_heartbeat,
        (data): boolean => {
          // for the pull consumer - missing heartbeats may be corrected
          // on the next pull etc - the only assumption here is we should
          // reset and check if the consumer was deleted from under us
          this.notify(ConsumerEvents.HeartbeatsMissed, data);
          this.resetPending()
            .then(() => {
            })
            .catch(() => {
            });
          return false;
        },
        { maxOut: 2 },
      );
    }

    // now if we disconnect, the consumer could be gone
    // or we were slow consumer'ed by the server
    (async () => {
      const status = this.consumer.api.nc.status();
      this.statusIterator = status as QueuedIteratorImpl<Status>;
      for await (const s of status) {
        switch (s.type) {
          case "disconnect":
            // don't spam hb errors if we are disconnected
            // @ts-ignore: optional chaining
            this.monitor?.cancel();
            break;
          case "reconnect":
            // do some sanity checks and reset
            // if that works resume the monitor
            this.resetPending()
              .then((ok) => {
                if (ok) {
                  // @ts-ignore: optional chaining
                  this.monitor?.restart();
                }
              })
              .catch(() => {
                // ignored - this should have fired elsewhere
              });
            break;
          default:
            // ignored
        }
      }
    })();

    // this is the initial pull
    this.pull(this.pullOptions());
  }

  /**
   * Handle the notification of 409 error and whether
   * it should reject the operation by returning an Error or null
   * @param status
   */
  handle409(status: JetStreamStatus): Error | null {
    const { code, description } = status;
    if (status.isConsumerDeleted()) {
      this.notify(ConsumerEvents.ConsumerDeleted, { code, description });
    } else if (status.isExceededLimit()) {
      this.notify(ConsumerEvents.ExceededLimit, { code, description });
    }
    if (!this.isConsume) {
      return status.toError();
    }
    if (status.isConsumerDeleted() && this.abortOnMissingResource) {
      return status.toError();
    }
    return null;
  }

  reset() {
    // stop the monitoring if running
    this.monitor?.cancel();

    const ocs = this.consumer.orderedConsumerState!;
    const { name } = this.consumer._info?.config;
    if (name) {
      this.notify(ConsumerDebugEvents.Reset, name);
      this.consumer.api.delete(this.consumer.stream, name)
        .catch(() => {
          // ignored
        });
    }

    // serial is updated here
    const config = this.consumer.getConsumerOpts();
    this.inbox = `${this.inboxPrefix}.${this.consumer.serial}`;
    // reset delivery seq
    ocs.cursor.deliver_seq = 0;
    // if they do a consumer info, they get the new one.
    this.consumer.name = config.name!;

    // remap the subscription
    this.consumer.api.nc._resub(this.sub, this.inbox);
    // create the consumer
    this.consumer.api.add(
      this.consumer.stream,
      config,
    ).then((ci) => {
      ocs.createFails = 0;
      this.consumer._info = ci;
      this.notify(ConsumerEvents.OrderedConsumerRecreated, ci.name);
      this.monitor?.restart();
      this.pull(this.pullOptions());
    }).catch((err) => {
      ocs.createFails++;
      if (err.message === "stream not found") {
        this.notify(
          ConsumerEvents.StreamNotFound,
          ocs.createFails,
        );
        if (this.abortOnMissingResource) {
          this.stop(err);
          return;
        }
      }
      // we have attempted to create 30 times, never succeeded
      if (
        ocs.createFails >= 30 &&
        this.received === 0
      ) {
        this.stop(err);
      }
      const bo = backoff();
      const c = delay(
        bo.backoff(ocs.createFails),
      );
      c.then(() => {
        const idx = this.cancelables.indexOf(c);
        if (idx !== -1) {
          this.cancelables = this.cancelables.splice(idx, idx);
        }
        if (!this.done) {
          this.reset();
        }
      })
        .catch((_) => {
          // canceled
        });
      this.cancelables.push(c);
    });
  }

  _push(r: JsMsg | CallbackFn) {
    if (!this.callback) {
      super.push(r);
    } else {
      const fn = typeof r === "function" ? r as CallbackFn : null;
      try {
        if (!fn) {
          const m = r as JsMsg;
          this.callback(m);
        } else {
          fn();
        }
      } catch (err) {
        this.stop(err as Error);
      }
    }
  }

  notify(type: ConsumerEvents | ConsumerDebugEvents, data: unknown) {
    if (this.listeners.length > 0) {
      (() => {
        this.listeners.forEach((l) => {
          const qi = l as QueuedIteratorImpl<ConsumerStatus>;
          if (!qi.done) {
            qi.push({ type, data });
          }
        });
      })();
    }
  }

  resetPending(): Promise<boolean> {
    return this.bind ? this.resetPendingNoInfo() : this.resetPendingWithInfo();
  }

  resetPendingNoInfo(): Promise<boolean> {
    // here we are blind - we won't do an info, so all we are doing
    // is invalidating the previous request results.
    this.pending.msgs = 0;
    this.pending.bytes = 0;
    this.pending.requests = 0;
    this.pull(this.pullOptions());
    return Promise.resolve(true);
  }

  async resetPendingWithInfo(): Promise<boolean> {
    let notFound = 0;
    let streamNotFound = 0;
    const bo = backoff();
    let attempt = 0;
    while (true) {
      if (this.done) {
        return false;
      }
      if (this.consumer.api.nc.isClosed()) {
        console.error("aborting resetPending - connection is closed");
        return false;
      }
      try {
        // check we exist
        await this.consumer.info();
        notFound = 0;
        // we exist, so effectively any pending state is gone
        // so reset and re-pull
        this.pending.msgs = 0;
        this.pending.bytes = 0;
        this.pending.requests = 0;
        this.pull(this.pullOptions());
        return true;
      } catch (err) {
        // game over
        if ((err as Error).message === "stream not found") {
          streamNotFound++;
          this.notify(ConsumerEvents.StreamNotFound, streamNotFound);
          if (!this.isConsume || this.abortOnMissingResource) {
            this.stop(err as Error);
            return false;
          }
        } else if ((err as Error).message === "consumer not found") {
          notFound++;
          this.notify(ConsumerEvents.ConsumerNotFound, notFound);
          if (!this.isConsume || this.abortOnMissingResource) {
            if (this.consumer.ordered) {
              const ocs = this.consumer.orderedConsumerState!;
              ocs.needsReset = true;
            }
            this.stop(err as Error);
            return false;
          }
          if (this.consumer.ordered) {
            this.reset();
            return false;
          }
        } else {
          notFound = 0;
          streamNotFound = 0;
        }
        const to = bo.backoff(attempt);
        // wait for delay or till the client closes
        const de = delay(to);
        await Promise.race([de, this.consumer.api.nc.closed()]);
        de.cancel();
        attempt++;
      }
    }
  }

  pull(opts: Partial<PullOptions>) {
    this.pending.bytes += opts.max_bytes ?? 0;
    this.pending.msgs += opts.batch ?? 0;
    this.pending.requests++;

    const nc = this.consumer.api.nc;
    //@ts-ignore: iterator will pull
    const subj =
      `${this.consumer.api.prefix}.CONSUMER.MSG.NEXT.${this.consumer.stream}.${this.consumer._info.name}`;
    this._push(() => {
      nc.publish(
        subj,
        JSON.stringify(opts),
        { reply: this.inbox },
      );
      this.notify(ConsumerDebugEvents.Next, opts);
    });
  }

  pullOptions(): Partial<PullOptions> {
    const batch = this.opts.max_messages - this.pending.msgs;
    const max_bytes = this.opts.max_bytes - this.pending.bytes;
    const idle_heartbeat = nanos(this.opts.idle_heartbeat!);
    const expires = nanos(this.opts.expires!);

    const opts = { batch, max_bytes, idle_heartbeat, expires } as PullOptions;

    if (isOverflowOptions(this.opts)) {
      opts.group = this.opts.group;
      if (this.opts.min_pending) {
        opts.min_pending = this.opts.min_pending;
      }
      if (this.opts.min_ack_pending) {
        opts.min_ack_pending = this.opts.min_ack_pending;
      }
    }
    return opts;
  }

  trackTimeout(t: Timeout<unknown>) {
    this.timeout = t;
  }

  close(): Promise<void | Error> {
    this.stop();
    return this.iterClosed;
  }

  closed(): Promise<void | Error> {
    return this.iterClosed;
  }

  clearTimers() {
    this.monitor?.cancel();
    this.monitor = null;
    this.timeout?.cancel();
    this.timeout = null;
  }

  override stop(err?: Error) {
    if (this.done) {
      return;
    }
    this.sub?.unsubscribe();
    this.clearTimers();
    this.statusIterator?.stop();
    //@ts-ignore: fn
    this._push(() => {
      super.stop(err);
      this.listeners.forEach((n) => {
        n.stop();
      });
    });
  }

  parseOptions(
    opts: PullConsumerOptions,
    refilling = false,
  ): InternalPullOptions {
    const args = (opts || {}) as InternalPullOptions;
    args.max_messages = args.max_messages || 0;
    args.max_bytes = args.max_bytes || 0;

    if (args.max_messages !== 0 && args.max_bytes !== 0) {
      throw errors.InvalidArgumentError.format(
        ["max_messages", "max_bytes"],
        "are mutually exclusive",
      );
    }

    // we must have at least one limit - default to 100 msgs
    // if they gave bytes but no messages, we will clamp
    // if they gave byte limits, we still need a message limit
    // or the server will send a single message and close the
    // request
    if (args.max_messages === 0) {
      // FIXME: if the server gives end pull completion, then this is not
      //   needed - the client will get 1 message but, we'll know that it
      //   worked - but we'll add a lot of latency, since all requests
      //   will end after one message
      args.max_messages = 100;
    }

    args.expires = args.expires || 30_000;
    if (args.expires < 1000) {
      throw errors.InvalidArgumentError.format(
        "expires",
        "must be at least 1000ms",
      );
    }

    // require idle_heartbeat
    args.idle_heartbeat = args.idle_heartbeat || args.expires / 2;
    args.idle_heartbeat = args.idle_heartbeat > 30_000
      ? 30_000
      : args.idle_heartbeat;

    if (refilling) {
      const minMsgs = Math.round(args.max_messages * .75) || 1;
      args.threshold_messages = args.threshold_messages || minMsgs;

      const minBytes = Math.round(args.max_bytes * .75) || 1;
      args.threshold_bytes = args.threshold_bytes || minBytes;
    }

    if (isOverflowOptions(opts)) {
      const { min, ok } = this.consumer.api.nc.features.get(
        Feature.JS_PRIORITY_GROUPS,
      );
      if (!ok) {
        throw new Error(`priority_groups require server ${min}`);
      }
      validateOverflowPullOptions(opts);
      if (opts.group) {
        args.group = opts.group;
      }
      if (opts.min_ack_pending) {
        args.min_ack_pending = opts.min_ack_pending;
      }
      if (opts.min_pending) {
        args.min_pending = opts.min_pending;
      }
    }

    return args;
  }

  status(): AsyncIterable<ConsumerStatus> {
    const iter = new QueuedIteratorImpl<ConsumerStatus>();
    this.listeners.push(iter);
    return iter;
  }
}

export class PullConsumerImpl implements Consumer {
  api: ConsumerAPIImpl;
  _info!: ConsumerInfo;
  stream: string;
  name!: string;
  opts: Partial<OrderedConsumerOptions>;
  type: PullConsumerType;
  messages?: PullConsumerMessagesImpl;
  ordered: boolean;
  serial: number;
  orderedConsumerState?: OrderedConsumerState;

  constructor(
    api: ConsumerAPI,
    info: ConsumerInfo,
    opts: Partial<OrderedConsumerOptions> | null = null,
  ) {
    this.api = api as ConsumerAPIImpl;
    this._info = info;
    this.name = info.name;
    this.stream = info.stream_name;
    this.ordered = opts !== null;
    this.opts = opts || {};
    this.serial = 1;
    this.type = PullConsumerType.Unset;
  }

  debug() {
    console.log({
      serial: this.serial,
      cursor: this.orderedConsumerState?.cursor,
    });
  }

  isPullConsumer(): boolean {
    return true;
  }

  isPushConsumer(): boolean {
    return false;
  }

  consume(
    opts: ConsumeOptions = {
      max_messages: 100,
      expires: 30_000,
    } as ConsumeMessages,
  ): Promise<ConsumerMessages> {
    if (this.ordered) {
      if (opts.bind) {
        return Promise.reject(
          errors.InvalidArgumentError.format("bind", "is not supported"),
        );
      }
      if (this.type === PullConsumerType.Fetch) {
        return Promise.reject(
          new errors.InvalidOperationError(
            "ordered consumer initialized as fetch",
          ),
        );
      }
      if (this.type === PullConsumerType.Consume) {
        return Promise.reject(
          new errors.InvalidOperationError(
            "ordered consumer doesn't support concurrent consume",
          ),
        );
      }
      this.type = PullConsumerType.Consume;
    }
    return Promise.resolve(
      new PullConsumerMessagesImpl(this, opts, true),
    );
  }

  async fetch(
    opts: FetchOptions = {
      max_messages: 100,
      expires: 30_000,
    } as FetchMessages,
  ): Promise<ConsumerMessages> {
    if (this.ordered) {
      if (opts.bind) {
        return Promise.reject(
          errors.InvalidArgumentError.format("bind", "is not supported"),
        );
      }
      if (this.type === PullConsumerType.Consume) {
        return Promise.reject(
          new errors.InvalidOperationError(
            "ordered consumer already initialized as consume",
          ),
        );
      }
      if (this.messages?.done === false) {
        return Promise.reject(
          new errors.InvalidOperationError(
            "ordered consumer doesn't support concurrent fetch",
          ),
        );
      }
      if (this.ordered) {
        if (this.orderedConsumerState?.cursor?.deliver_seq) {
          // make the start sequence one than have been seen
          this._info.config.opt_start_seq! =
            this.orderedConsumerState?.cursor.stream_seq + 1;
        }
        if (this.orderedConsumerState?.needsReset === true) {
          await this._reset();
        }
      }

      this.type = PullConsumerType.Fetch;
    }

    const m = new PullConsumerMessagesImpl(this, opts);
    if (this.ordered) {
      this.messages = m;
    }
    // FIXME: need some way to pad this correctly
    const to = Math.round(m.opts.expires! * 1.05);
    const timer = timeout(to);
    m.closed().catch((err) => {
      console.log(err);
    }).finally(() => {
      timer.cancel();
    });
    timer.catch(() => {
      m.close().catch();
    });
    m.trackTimeout(timer);

    return Promise.resolve(m);
  }

  async next(
    opts: NextOptions = { expires: 30_000 },
  ): Promise<JsMsg | null> {
    const fopts = opts as FetchMessages;
    fopts.max_messages = 1;

    const iter = await this.fetch(fopts);
    for await (const m of iter) {
      return m;
    }
    return null;
  }

  delete(): Promise<boolean> {
    const { stream_name, name } = this._info;
    return this.api.delete(stream_name, name);
  }

  getConsumerOpts(): ConsumerConfig {
    const ocs = this.orderedConsumerState!;
    this.serial++;
    this.name = `${ocs.namePrefix}_${this.serial}`;

    const conf = Object.assign({}, this._info.config, {
      name: this.name,
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: ocs.cursor.stream_seq + 1,
      ack_policy: AckPolicy.None,
      inactive_threshold: nanos(5 * 60 * 1000),
      num_replicas: 1,
    });

    delete conf.metadata;
    return conf;
  }

  async _reset(): Promise<ConsumerInfo> {
    if (this.messages === undefined) {
      throw new Error("not possible to reset");
    }
    this.delete().catch(() => {
      //ignored
    });
    const conf = this.getConsumerOpts();
    const ci = await this.api.add(this.stream, conf);
    this._info = ci;
    return ci;
  }

  async info(cached = false): Promise<ConsumerInfo> {
    if (cached) {
      return Promise.resolve(this._info);
    }
    const { stream_name, name } = this._info;
    this._info = await this.api.info(stream_name, name);
    return this._info;
  }
}

export function validateOverflowPullOptions(opts: unknown) {
  if (isOverflowOptions(opts)) {
    minValidation("group", opts.group);
    if (opts.group.length > 16) {
      throw errors.InvalidArgumentError.format(
        "group",
        "must be 16 characters or less",
      );
    }

    const { min_pending, min_ack_pending } = opts;
    if (!min_pending && !min_ack_pending) {
      throw errors.InvalidArgumentError.format(
        ["min_pending", "min_ack_pending"],
        "at least one must be specified",
      );
    }

    if (min_pending && typeof min_pending !== "number") {
      throw errors.InvalidArgumentError.format(
        ["min_pending"],
        "must be a number",
      );
    }

    if (min_ack_pending && typeof min_ack_pending !== "number") {
      throw errors.InvalidArgumentError.format(
        ["min_ack_pending"],
        "must be a number",
      );
    }
  }
}
