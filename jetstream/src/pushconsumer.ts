/*
 * Copyright 2024 Synadia Communications, Inc
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

import { toJsMsg } from "./jsmsg.ts";
import type { JsMsg } from "./jsmsg.ts";
import { AckPolicy, DeliverPolicy } from "./jsapi_types.ts";
import type { ConsumerConfig, ConsumerInfo } from "./jsapi_types.ts";
import type { ConsumerNotification } from "./types.ts";
import { JsHeaders } from "./types.ts";

import type {
  ConsumerAPI,
  ConsumerCallbackFn,
  ConsumerMessages,
  PushConsumer,
  PushConsumerOptions,
} from "./types.ts";
import type { ConsumerAPIImpl } from "./jsmconsumer_api.ts";
import {
  backoff,
  createInbox,
  delay,
  Empty,
  errors,
  IdleHeartbeatMonitor,
  millis,
  nanos,
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
import { JetStreamStatus } from "./jserrors.ts";
import type { MsgImpl } from "@nats-io/nats-core/internal";

export class PushConsumerMessagesImpl extends QueuedIteratorImpl<JsMsg>
  implements ConsumerMessages {
  consumer: PushConsumerImpl;
  sub!: Subscription;
  monitor: IdleHeartbeatMonitor | null;
  listeners: QueuedIterator<ConsumerNotification>[];
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
  lastFlowControlSubject: string | null;

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
    this.lastFlowControlSubject = null;
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
      this.notify({ type: "ordered_consumer_recreated", name: ci.name });
    }).catch((err) => {
      this.createFails++;
      if (err.message === "stream not found") {
        this.notify({
          type: "stream_not_found",
          name: this.consumer.stream,
          consumerCreateFails: this.createFails,
        });
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
        if (!this.done) {
          this.reset();
        }
      }).catch(() => {})
        .finally(() => {
          const idx = this.cancelables.indexOf(c);
          if (idx !== -1) {
            this.cancelables = this.cancelables.splice(idx, idx);
          }
        });
      this.cancelables.push(c);
    });
  }

  getConsumerOpts(): ConsumerConfig {
    // inactive_threshold is carried over from the current consumer config
    const src = Object.assign({}, this.consumer._info.config);
    this.serial++;
    const name = `${this.namePrefix}_${this.serial}`;

    return Object.assign(src, {
      name,
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: this.cursor.stream_seq + 1,
      ack_policy: AckPolicy.None,
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
  status(): AsyncIterable<ConsumerNotification> {
    const iter = new QueuedIteratorImpl<ConsumerNotification>();
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
        (count): boolean => {
          this.notify({ type: "heartbeats_missed", count });
          if (this.ordered) {
            this.reset();
          }
          return false;
        },
        { maxOut: 2 },
      );
    }

    this.statusIterator = this.consumer.api.nc
      .status() as QueuedIteratorImpl<Status>;
    (async () => {
      for await (const s of this.statusIterator) {
        switch (s.type) {
          case "disconnect":
            this.monitor?.cancel();
            break;
          case "reconnect":
            this.monitor?.restart();
            break;
          case "error":
            // if the client cannot respond to flow control or stalled
            // notifications the consumer will never resume - fail it
            if (this.isFlowControlViolation(s.error)) {
              this.stop(s.error);
            }
            break;
          default:
            // ignored
        }
      }
    })();

    this.sub = this.consumer.api.nc.subscribe(subject, {
      queue,
      callback: (err, msg) => {
        if (err) {
          this.stop(err);
          return;
        }
        this.monitor?.work();

        // need to make sure to catch all protocol messages even
        const isProtocol = this.ordered
          ? msg.subject.indexOf(this?.deliverPrefix!) === 0
          : msg.subject === subject;

        if (isProtocol) {
          if (msg.subject !== this.sub.getSubject()) {
            // this is a stale message - was not sent to the current inbox
            return;
          }

          const status = new JetStreamStatus(msg);
          if (status.isFlowControlRequest()) {
            this._push(() => {
              this.lastFlowControlSubject = msg.reply || null;
              msg.respond();
              this.notify({ type: "flow_control" });
            });
            return;
          }

          if (status.isIdleHeartbeat()) {
            const lastConsumerSequence = parseInt(
              msg.headers?.get(JsHeaders.LastConsumerSeqHdr) || "0",
            );
            const lastStreamSequence = parseInt(
              msg.headers?.get(JsHeaders.LastStreamSeqHdr) ?? "0",
            );
            // the server is waiting on a flow control response
            const maybeStuck = msg.headers?.get(JsHeaders.ConsumerStalledHdr);
            const stalled = typeof maybeStuck === "string" && maybeStuck !== "";
            this.notify({
              type: "heartbeat",
              lastStreamSequence,
              lastConsumerSequence,
              stalled,
            });

            if (stalled) {
              // FIX for https://github.com/nats-io/nats.js/issues/374
              // respond on the stalled subject so the consumer resumes
              this.lastFlowControlSubject = maybeStuck;
              (msg as MsgImpl).publisher.publish(maybeStuck, Empty);
            } else if (
              this.ordered && lastConsumerSequence !== this.cursor.deliver_seq
            ) {
              // FIX for https://github.com/nats-io/nats.js/issues/426
              // the server sent messages we didn't get (ie the tail of the
              // stream was lost) - no message will reveal the gap, so reset
              this.reset();
            }
            return;
          }

          const code = status.code;
          const description = status.description;

          if (status.isConsumerDeleted()) {
            this.notify({ type: "consumer_deleted", code, description });
          }
          if (this.abortOnMissingResource) {
            this._push(() => {
              this.stop(status.toError());
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

  // returns true if the error is a publish permissions violation
  // for a flow control response or stalled notification for this consumer
  isFlowControlViolation(err: Error): boolean {
    if (!(err instanceof errors.PermissionViolationError)) {
      return false;
    }
    if (err.operation !== "publish" || !err.subject) {
      return false;
    }
    // the server reports the subject the client published. flow control and
    // stalled subjects are server provided (msg.reply / the stalled header)
    // and may be remapped, so match on exactly what was last published. a
    // denied flow control response stalls the consumer, and the server keeps
    // sending the same subject in the stalled header with each heartbeat
    return err.subject === this.lastFlowControlSubject;
  }

  notify(n: ConsumerNotification) {
    if (this.listeners.length > 0) {
      (() => {
        this.listeners.forEach((l) => {
          const qi = l as QueuedIteratorImpl<ConsumerNotification>;
          if (!qi.done) {
            qi.push(n);
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
    userOptions = { ...userOptions };
    if (this.started) {
      return Promise.reject(
        new errors.InvalidOperationError("consumer already started"),
      );
    }

    if (!this._info.config.deliver_subject) {
      return Promise.reject(
        new Error("deliver_subject is not set, not a push consumer"),
      );
    }
    if (!this._info.config.deliver_group && this._info.push_bound) {
      return Promise.reject(
        new errors.InvalidOperationError("consumer is already bound"),
      );
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
      return Promise.reject(
        new errors.InvalidOperationError("bound consumers cannot delete"),
      );
    }
    const { stream_name, name } = this._info;
    return this.api.delete(stream_name, name);
  }

  async info(cached?: boolean): Promise<ConsumerInfo> {
    if (this.bound) {
      return Promise.reject(
        new errors.InvalidOperationError("bound consumers cannot info"),
      );
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

// tracks the last message delivered by an ordered push consumer, so that an
// idle heartbeat can confirm that everything the server sent was received.
// the server only sends idle heartbeats when it has nothing to deliver, and
// reports the last delivery sequence it sent.
export class DeliveryTracker {
  // consumer that is currently delivering - changes when the ordered
  // consumer is recreated (delivery sequences restart)
  current: string;
  // consumer and delivery sequence of the last received message
  consumer: string;
  seq: number;
  done: boolean;

  constructor(name: string) {
    this.current = name;
    this.consumer = name;
    this.seq = 0;
    this.done = false;
  }

  received(m: JsMsg) {
    this.consumer = m.info.consumer;
    this.seq = m.info.deliverySequence;
  }

  // returns true if the notification confirms all messages were received
  isComplete(s: ConsumerNotification): boolean {
    if (s.type === "ordered_consumer_recreated") {
      this.current = s.name;
      return false;
    }
    if (s.type === "heartbeat" && !s.stalled) {
      const seq = this.consumer === this.current ? this.seq : 0;
      return s.lastConsumerSequence === seq;
    }
    return false;
  }

  // the consumer can close without an error (ie the connection closed) -
  // if that happens before all messages were received, that is an error
  closeError(err: Error | void, msg: string): Error | undefined {
    if (err) {
      return err;
    }
    return this.done ? undefined : new Error(msg);
  }
}
