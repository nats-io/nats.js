import { toJsMsg } from "./jsmsg.ts";
import type { JsMsg } from "./jsmsg.ts";
import type { ConsumerInfo } from "./jsapi_types.ts";
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
  Events,
  IdleHeartbeatMonitor,
  millis,
  NatsError,
  QueuedIteratorImpl,
} from "@nats-io/nats-core/internal";
import type {
  CallbackFn,
  QueuedIterator,
  Subscription,
  SubscriptionImpl,
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

  constructor(c: PushConsumerImpl, opts: Partial<PushConsumerOptions> = {}) {
    super();
    this.consumer = c;
    this.monitor = null;
    this.listeners = [];
    this.abortOnMissingResource = opts.abort_on_missing_resource === true;
    this.callback = opts.callback || null;
    this.noIterator = this.callback !== null;
    this.start();
  }
  closed(): Promise<void | Error> {
    return this.iterClosed;
  }
  close(): Promise<void | Error> {
    this.stop();
    return this.iterClosed;
  }

  stop(err?: Error) {
    if (this.done) {
      return;
    }
    this.monitor?.cancel();
    this.monitor = null;
    this._push(() => {
      super.stop(err);
      this.listeners.forEach((n) => {
        n.stop();
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
        this.stop(err);
      }
    }
  }

  status(): Promise<AsyncIterable<ConsumerStatus>> {
    const iter = new QueuedIteratorImpl<ConsumerStatus>();
    this.listeners.push(iter);
    return Promise.resolve(iter);
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
        const status = this.consumer.api.nc.status();
        for await (const s of status) {
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
          this._push(toJsMsg(msg));
        }
      },
    });

    this.sub.closed.then(() => {
      // for ordered consumer we cannot break the iterator
      if ((this.sub as SubscriptionImpl).draining) {
        this._push(() => {
          this.stop();
        });
      }
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

export class PushConsumerImpl implements PushConsumer {
  api: ConsumerAPIImpl;
  _info: ConsumerInfo;
  stream: string;
  name: string;
  bound: boolean;
  started: boolean;

  constructor(api: ConsumerAPI, info: ConsumerInfo, bound = false) {
    this.api = api as ConsumerAPIImpl;
    this._info = info;
    this.stream = info.stream_name;
    this.name = info.name;
    this.bound = bound;
    this.started = false;
  }

  consume(opts: Partial<PushConsumerOptions> = {}): Promise<ConsumerMessages> {
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
    const v = new PushConsumerMessagesImpl(this, opts);
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
    const { stream_name, name } = this._info;
    const info = await this.api.info(stream_name, name);
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
