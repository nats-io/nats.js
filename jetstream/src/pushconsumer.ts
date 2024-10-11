import { toJsMsg } from "./jsmsg.ts";
import type { JsMsg } from "./jsmsg.ts";
import { AckPolicy, DeliverPolicy } from "./jsapi_types.ts";
import type { ConsumerConfig, ConsumerInfo } from "./jsapi_types.ts";
import { ConsumerDebugEvents, ConsumerEvents } from "./types.ts";

import type {
  ConsumerAPI,
  ConsumerCallbackFn,
  ConsumerMessages,
  ConsumerStatus,
  PushConsumer,
  PushConsumerOptions,
} from "./types.ts";
import type { ConsumerAPIImpl } from "./jsmconsumer_api.ts";
import {
  backoff,
  createInbox,
  delay,
  Events,
  IdleHeartbeatMonitor,
  millis,
  nanos,
  NatsError,
  nuid,
  QueuedIteratorImpl,
} from "@nats-io/nats-core/internal";
import type {
  CallbackFn,
  Delay,
  QueuedIterator,
  Status,
  Subscription,
} from "@nats-io/nats-core/internal";
import { isFlowControlMsg, isHeartbeatMsg } from "./mod.ts";

export class PushConsumerMessagesImpl extends QueuedIteratorImpl<JsMsg>
  implements ConsumerMessages {
  consumer: PushConsumerImpl;
  sub!: Subscription;
  monitor: IdleHeartbeatMonitor | null;
  listeners: QueuedIterator<ConsumerStatus>[];
  abortOnMissingResource: boolean;
  callback: ConsumerCallbackFn | null;
  ordered: boolean;
  cursor!: { stream_seq: number; deliver_seq: number };
  namePrefix: string | null;
  deliverPrefix: string | null;
  serial: number;
  createFails!: number;
  statusIterator!: QueuedIteratorImpl<Status>;
  cancelables: Delay[];

  constructor(
    c: PushConsumerImpl,
    userOptions: Partial<PushConsumerOptions> = {},
    internalOptions: Partial<PushConsumerInternalOptions> = {},
  ) {
    super();
    this.consumer = c;
    this.monitor = null;
    this.listeners = [];
    this.cancelables = [];
    this.abortOnMissingResource =
      userOptions.abort_on_missing_resource === true;
    this.callback = userOptions.callback || null;
    this.noIterator = this.callback !== null;
    this.namePrefix = null;
    this.deliverPrefix = null;
    this.ordered = internalOptions.ordered === true;
    this.serial = 1;
    if (this.ordered) {
      this.namePrefix = internalOptions.name_prefix ?? `oc_${nuid.next()}`;
      // this already should be set
      this.deliverPrefix = internalOptions.deliver_prefix ??
        createInbox(this.consumer.api.nc.options.inboxPrefix);
      this.cursor = { stream_seq: 1, deliver_seq: 0 };
      const startSeq = c._info.config.opt_start_seq || 0;
      this.cursor.stream_seq = startSeq > 0 ? startSeq - 1 : 0;
      this.createFails = 0;
    }

    this.start();
  }

  reset() {
    const { name } = this.consumer._info?.config;
    if (name) {
      this.consumer.api.delete(this.consumer.stream, name)
        .catch(() => {
          // ignored
        });
    }

    const config = this.getConsumerOpts();
    // reset delivery seq
    this.cursor.deliver_seq = 0;
    // if they do a consumer info, they get the new one.
    this.consumer.name = config.name!;
    // sync the serial - if they stop and restart, it will go forward
    this.consumer.serial = this.serial;
    // remap the subscription
    this.consumer.api.nc._resub(this.sub, config.deliver_subject!);
    // create the consumer
    this.consumer.api.add(
      this.consumer.stream,
      config,
    ).then((ci) => {
      this.createFails = 0;
      this.consumer._info = ci;
      this.notify(ConsumerEvents.OrderedConsumerRecreated, ci.name);
    }).catch((err) => {
      this.createFails++;
      if (err.message === "stream not found") {
        this.notify(ConsumerEvents.StreamNotFound, this.createFails);
        if (this.abortOnMissingResource) {
          this.stop(err);
          return;
        }
      }
      // we have attempted to create 30 times, never succeeded
      if (this.createFails >= 30 && this.received === 0) {
        this.stop(err);
      }
      const bo = backoff();
      const c = delay(bo.backoff(this.createFails));
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

  getConsumerOpts(): ConsumerConfig {
    const src = Object.assign({}, this.consumer._info.config);
    this.serial++;
    const name = `${this.namePrefix}_${this.serial}`;

    return Object.assign(src, {
      name,
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: this.cursor.stream_seq + 1,
      ack_policy: AckPolicy.None,
      inactive_threshold: nanos(5 * 60 * 1000),
      num_replicas: 1,
      flow_control: true,
      idle_heartbeat: nanos(30 * 1000),
      deliver_subject: `${this.deliverPrefix}.${this.serial}`,
    });
  }

  closed(): Promise<void | Error> {
    return this.iterClosed;
  }
  close(): Promise<void | Error> {
    this.stop();
    return this.iterClosed;
  }

  override stop(err?: Error) {
    if (this.done) {
      return;
    }
    this.statusIterator?.stop();
    this.monitor?.cancel();
    this.monitor = null;
    // if we have delays, stop them
    this.cancelables.forEach((c) => {
      c.cancel();
    });
    Promise.all(this.cancelables)
      .then(() => {
        this.cancelables = [];
      })
      .catch(() => {})
      .finally(() => {
        this._push(() => {
          super.stop(err);
          this.listeners.forEach((n) => {
            n.stop();
          });
        });
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
          this.received++;
          this.callback(m);
          this.processed++;
        } else {
          fn();
        }
      } catch (err) {
        this.stop(err as Error);
      }
    }
  }
  status(): AsyncIterable<ConsumerStatus> {
    const iter = new QueuedIteratorImpl<ConsumerStatus>();
    this.listeners.push(iter);
    return iter;
  }

  start(): void {
    const {
      deliver_subject: subject,
      deliver_group: queue,
      idle_heartbeat: hbNanos,
    } = this.consumer._info.config;
    if (!subject) {
      // this shouldn't happen - the push consumer should be validated
      throw new Error("bad consumer info");
    }

    if (hbNanos) {
      const ms = millis(hbNanos);
      this.monitor = new IdleHeartbeatMonitor(
        ms,
        (data): boolean => {
          this.notify(ConsumerEvents.HeartbeatsMissed, data);
          return false;
        },
        { maxOut: 2 },
      );

      (async () => {
        this.statusIterator = this.consumer.api.nc
          .status() as QueuedIteratorImpl<Status>;
        for await (const s of this.statusIterator) {
          switch (s.type) {
            case Events.Disconnect:
              this.monitor?.cancel();
              break;
            case Events.Reconnect:
              this.monitor?.restart();
              break;
            default:
              // ignored
          }
        }
      })();
    }

    this.sub = this.consumer.api.nc.subscribe(subject, {
      queue,
      callback: (err, msg) => {
        if (err) {
          this.stop(err);
          return;
        }
        this.monitor?.work();

        const isProtocol = msg.subject === subject;
        if (isProtocol) {
          if (isHeartbeatMsg(msg)) {
            const natsLastConsumer = msg.headers?.get("Nats-Last-Consumer");
            const natsLastStream = msg.headers?.get("Nats-Last-Stream");
            this.notify(ConsumerDebugEvents.Heartbeat, {
              natsLastConsumer,
              natsLastStream,
            });
            return;
          }
          if (isFlowControlMsg(msg)) {
            this._push(() => {
              msg.respond();
              this.notify(ConsumerDebugEvents.FlowControl, null);
            });
            return;
          }

          const code = msg.headers?.code;
          const description = msg.headers?.description?.toLowerCase() ||
            "unknown";

          if (code === 409 && description === "consumer deleted") {
            this.notify(
              ConsumerEvents.ConsumerDeleted,
              `${code} ${description}`,
            );
          }
          if (this.abortOnMissingResource) {
            this._push(() => {
              const error = new NatsError(description, `${code}`);
              this.stop(error);
            });
            return;
          }
        } else {
          const m = toJsMsg(msg);
          if (this.ordered) {
            const dseq = m.info.deliverySequence;
            if (dseq !== this.cursor.deliver_seq + 1) {
              this.reset();
              return;
            }
            this.cursor.deliver_seq = dseq;
            this.cursor.stream_seq = m.info.streamSequence;
          }
          this._push(m);
        }
      },
    });

    this.sub.closed.then(() => {
      // for ordered consumer we cannot break the iterator
      this._push(() => {
        this.stop();
      });
    });

    this.closed().then(() => {
      this.sub?.unsubscribe();
    });
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
}

export type PushConsumerInternalOptions = PushConsumerOptions & {
  bound: boolean;
  ordered: boolean;
  name_prefix: string;
  deliver_prefix: string;
};

export class PushConsumerImpl implements PushConsumer {
  api: ConsumerAPIImpl;
  _info: ConsumerInfo;
  stream: string;
  name: string;
  bound: boolean;
  ordered: boolean;
  started: boolean;
  serial: number;
  opts: Partial<PushConsumerInternalOptions>;

  constructor(
    api: ConsumerAPI,
    info: ConsumerInfo,
    opts: Partial<PushConsumerInternalOptions> = {},
  ) {
    this.api = api as ConsumerAPIImpl;
    this._info = info;
    this.stream = info.stream_name;
    this.name = info.name;
    this.bound = opts.bound === true;
    this.started = false;
    this.opts = opts;
    this.serial = 0;
    this.ordered = opts.ordered || false;

    if (this.ordered) {
      this.serial = 1;
    }
  }

  consume(
    userOptions: Partial<PushConsumerOptions> = {},
  ): Promise<ConsumerMessages> {
    if (this.started) {
      return Promise.reject(new Error("consumer already started"));
    }

    if (!this._info.config.deliver_subject) {
      return Promise.reject(
        new Error("deliver_subject is not set, not a push consumer"),
      );
    }
    if (!this._info.config.deliver_group && this._info.push_bound) {
      return Promise.reject(new Error("consumer is already bound"));
    }
    const v = new PushConsumerMessagesImpl(this, userOptions, this.opts);
    this.started = true;
    v.closed().then(() => {
      this.started = false;
    });
    return Promise.resolve(v);
  }

  delete(): Promise<boolean> {
    if (this.bound) {
      return Promise.reject(new Error("bound consumers cannot delete"));
    }
    const { stream_name, name } = this._info;
    return this.api.delete(stream_name, name);
  }

  async info(cached?: boolean): Promise<ConsumerInfo> {
    if (this.bound) {
      return Promise.reject(new Error("bound consumers cannot info"));
    }
    if (cached) {
      return Promise.resolve(this._info);
    }
    // FIXME: this can possibly return a stale ci if this is an ordered
    //   consumer, and the consumer reset while we awaited the info...
    const info = await this.api.info(this.stream, this.name);
    this._info = info;
    return info;
  }

  isPullConsumer(): boolean {
    return false;
  }

  isPushConsumer(): boolean {
    return true;
  }
}
