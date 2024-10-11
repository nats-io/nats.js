/*
 * Copyright 2018-2023 The NATS Authors
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

import { deferred } from "./util.ts";
import { ProtocolHandler, SubscriptionImpl } from "./protocol.ts";
import { Empty } from "./encoders.ts";
import { NatsError } from "./types.ts";

import type { Features, SemVer } from "./semver.ts";
import { parseSemVer } from "./semver.ts";

import { parseOptions } from "./options.ts";
import { QueuedIteratorImpl } from "./queued_iterator.ts";
import { RequestMany, RequestOne } from "./request.ts";

import type { RequestManyOptionsInternal } from "./request.ts";

import { isRequestError } from "./msg.ts";
import { createInbox, ErrorCode, RequestStrategy } from "./core.ts";
import type { Dispatcher } from "./core.ts";

import type {
  ConnectionOptions,
  Context,
  Msg,
  NatsConnection,
  Payload,
  PublishOptions,
  QueuedIterator,
  RequestManyOptions,
  RequestOptions,
  ServerInfo,
  Stats,
  Status,
  Subscription,
  SubscriptionOptions,
} from "./core.ts";

export class NatsConnectionImpl implements NatsConnection {
  options: ConnectionOptions;
  protocol!: ProtocolHandler;
  draining: boolean;
  listeners: Dispatcher<Status>[];

  private constructor(opts: ConnectionOptions) {
    this.draining = false;
    this.options = parseOptions(opts);
    this.listeners = [];
  }

  public static connect(opts: ConnectionOptions = {}): Promise<NatsConnection> {
    return new Promise<NatsConnection>((resolve, reject) => {
      const nc = new NatsConnectionImpl(opts);
      ProtocolHandler.connect(nc.options, nc)
        .then((ph: ProtocolHandler) => {
          nc.protocol = ph;
          (async function () {
            for await (const s of ph.status()) {
              nc.listeners.forEach((l) => {
                l.push(s);
              });
            }
          })();
          resolve(nc);
        })
        .catch((err: Error) => {
          reject(err);
        });
    });
  }

  closed(): Promise<void | Error> {
    return this.protocol.closed;
  }

  async close() {
    await this.protocol.close();
  }

  _check(subject: string, sub: boolean, pub: boolean) {
    if (this.isClosed()) {
      throw NatsError.errorForCode(ErrorCode.ConnectionClosed);
    }
    if (sub && this.isDraining()) {
      throw NatsError.errorForCode(ErrorCode.ConnectionDraining);
    }
    if (pub && this.protocol.noMorePublishing) {
      throw NatsError.errorForCode(ErrorCode.ConnectionDraining);
    }
    subject = subject || "";
    if (subject.length === 0) {
      throw NatsError.errorForCode(ErrorCode.BadSubject);
    }
  }

  publish(
    subject: string,
    data?: Payload,
    options?: PublishOptions,
  ): void {
    this._check(subject, false, true);
    this.protocol.publish(subject, data, options);
  }

  publishMessage(msg: Msg): void {
    return this.publish(msg.subject, msg.data, {
      reply: msg.reply,
      headers: msg.headers,
    });
  }

  respondMessage(msg: Msg): boolean {
    if (msg.reply) {
      this.publish(msg.reply, msg.data, {
        reply: msg.reply,
        headers: msg.headers,
      });
      return true;
    }
    return false;
  }

  subscribe(
    subject: string,
    opts: SubscriptionOptions = {},
  ): Subscription {
    this._check(subject, true, false);
    const sub = new SubscriptionImpl(this.protocol, subject, opts);
    this.protocol.subscribe(sub);
    return sub;
  }

  _resub(s: Subscription, subject: string, max?: number) {
    this._check(subject, true, false);
    const si = s as SubscriptionImpl;
    // FIXME: need way of understanding a callbacks processed
    //   count without it, we cannot really do much - ie
    //   for rejected messages, the count would be lower, etc.
    //   To handle cases were for example KV is building a map
    //   the consumer would say how many messages we need to do
    //   a proper build before we can handle updates.
    si.max = max; // this might clear it
    if (max) {
      // we cannot auto-unsub, because we don't know the
      // number of messages we processed vs received
      // allow the auto-unsub on processMsg to work if they
      // we were called with a new max
      si.max = max + si.received;
    }
    this.protocol.resub(si, subject);
  }

  // possibilities are:
  // stop on error or any non-100 status
  // AND:
  // - wait for timer
  // - wait for n messages or timer
  // - wait for unknown messages, done when empty or reset timer expires (with possible alt wait)
  // - wait for unknown messages, done when an empty payload is received or timer expires (with possible alt wait)
  requestMany(
    subject: string,
    data: Payload = Empty,
    opts: Partial<RequestManyOptions> = { maxWait: 1000, maxMessages: -1 },
  ): Promise<QueuedIterator<Msg>> {
    const asyncTraces = !(this.protocol.options.noAsyncTraces || false);

    try {
      this._check(subject, true, true);
    } catch (err) {
      return Promise.reject(err);
    }

    opts.strategy = opts.strategy || RequestStrategy.Timer;
    opts.maxWait = opts.maxWait || 1000;
    if (opts.maxWait < 1) {
      return Promise.reject(new NatsError("timeout", ErrorCode.InvalidOption));
    }

    // the iterator for user results
    const qi = new QueuedIteratorImpl<Msg>();
    function stop(err?: Error) {
      qi.push(() => {
        qi.stop(err);
      });
    }

    // callback for the subscription or the mux handler
    // simply pushes errors and messages into the iterator
    function callback(err: Error | null, msg: Msg | null) {
      if (err || msg === null) {
        stop(err === null ? undefined : err);
      } else {
        qi.push(msg);
      }
    }

    if (opts.noMux) {
      // we setup a subscription and manage it
      const stack = asyncTraces ? new Error().stack : null;
      let max = typeof opts.maxMessages === "number" && opts.maxMessages > 0
        ? opts.maxMessages
        : -1;

      const sub = this.subscribe(createInbox(this.options.inboxPrefix), {
        callback: (err, msg) => {
          // we only expect runtime errors or a no responders
          if (
            msg?.data?.length === 0 &&
            msg?.headers?.status === ErrorCode.NoResponders
          ) {
            err = NatsError.errorForCode(ErrorCode.NoResponders);
          }
          // augment any error with the current stack to provide context
          // for the error on the suer code
          if (err) {
            if (stack) {
              err.stack += `\n\n${stack}`;
            }
            cancel(err);
            return;
          }
          // push the message
          callback(null, msg);
          // see if the m request is completed
          if (opts.strategy === RequestStrategy.Count) {
            max--;
            if (max === 0) {
              cancel();
            }
          }
          if (opts.strategy === RequestStrategy.JitterTimer) {
            clearTimers();
            timer = setTimeout(() => {
              cancel();
            }, 300);
          }
          if (opts.strategy === RequestStrategy.SentinelMsg) {
            if (msg && msg.data.length === 0) {
              cancel();
            }
          }
        },
      });
      (sub as SubscriptionImpl).requestSubject = subject;

      sub.closed
        .then(() => {
          stop();
        })
        .catch((err: Error) => {
          qi.stop(err);
        });

      const cancel = (err?: Error) => {
        if (err) {
          qi.push(() => {
            throw err;
          });
        }
        clearTimers();
        sub.drain()
          .then(() => {
            stop();
          })
          .catch((_err: Error) => {
            stop();
          });
      };

      qi.iterClosed
        .then(() => {
          clearTimers();
          sub?.unsubscribe();
        })
        .catch((_err) => {
          clearTimers();
          sub?.unsubscribe();
        });

      try {
        this.publish(subject, data, { reply: sub.getSubject() });
      } catch (err) {
        cancel(err as NatsError);
      }

      let timer = setTimeout(() => {
        cancel();
      }, opts.maxWait);

      const clearTimers = () => {
        if (timer) {
          clearTimeout(timer);
        }
      };
    } else {
      // the ingestion is the RequestMany
      const rmo = opts as RequestManyOptionsInternal;
      rmo.callback = callback;

      qi.iterClosed.then(() => {
        r.cancel();
      }).catch((err) => {
        r.cancel(err);
      });

      const r = new RequestMany(this.protocol.muxSubscriptions, subject, rmo);
      this.protocol.request(r);

      try {
        this.publish(
          subject,
          data,
          {
            reply: `${this.protocol.muxSubscriptions.baseInbox}${r.token}`,
            headers: opts.headers,
          },
        );
      } catch (err) {
        r.cancel(err as NatsError);
      }
    }

    return Promise.resolve(qi);
  }

  request(
    subject: string,
    data?: Payload,
    opts: RequestOptions = { timeout: 1000, noMux: false },
  ): Promise<Msg> {
    try {
      this._check(subject, true, true);
    } catch (err) {
      return Promise.reject(err);
    }
    const asyncTraces = !(this.protocol.options.noAsyncTraces || false);
    opts.timeout = opts.timeout || 1000;
    if (opts.timeout < 1) {
      return Promise.reject(new NatsError("timeout", ErrorCode.InvalidOption));
    }
    if (!opts.noMux && opts.reply) {
      return Promise.reject(
        new NatsError(
          "reply can only be used with noMux",
          ErrorCode.InvalidOption,
        ),
      );
    }

    if (opts.noMux) {
      const inbox = opts.reply
        ? opts.reply
        : createInbox(this.options.inboxPrefix);
      const d = deferred<Msg>();
      const errCtx = asyncTraces ? new Error() : null;
      const sub = this.subscribe(
        inbox,
        {
          max: 1,
          timeout: opts.timeout,
          callback: (err, msg) => {
            if (err) {
              // timeouts from `timeout()` will have the proper stack
              if (errCtx && err.code !== ErrorCode.Timeout) {
                err.stack += `\n\n${errCtx.stack}`;
              }
              sub.unsubscribe();
              d.reject(err);
            } else {
              err = isRequestError(msg);
              if (err) {
                // if we failed here, help the developer by showing what failed
                if (errCtx) {
                  err.stack += `\n\n${errCtx.stack}`;
                }
                d.reject(err);
              } else {
                d.resolve(msg);
              }
            }
          },
        },
      );
      (sub as SubscriptionImpl).requestSubject = subject;
      this.protocol.publish(subject, data, {
        reply: inbox,
        headers: opts.headers,
      });
      return d;
    } else {
      const r = new RequestOne(
        this.protocol.muxSubscriptions,
        subject,
        opts,
        asyncTraces,
      );
      this.protocol.request(r);

      try {
        this.publish(
          subject,
          data,
          {
            reply: `${this.protocol.muxSubscriptions.baseInbox}${r.token}`,
            headers: opts.headers,
          },
        );
      } catch (err) {
        r.cancel(err as NatsError);
      }

      const p = Promise.race([r.timer, r.deferred]);
      p.catch(() => {
        r.cancel();
      });
      return p;
    }
  }

  /** *
   * Flushes to the server. Promise resolves when round-trip completes.
   * @returns {Promise<void>}
   */
  flush(): Promise<void> {
    if (this.isClosed()) {
      return Promise.reject(
        NatsError.errorForCode(ErrorCode.ConnectionClosed),
      );
    }
    return this.protocol.flush();
  }

  drain(): Promise<void> {
    if (this.isClosed()) {
      return Promise.reject(
        NatsError.errorForCode(ErrorCode.ConnectionClosed),
      );
    }
    if (this.isDraining()) {
      return Promise.reject(
        NatsError.errorForCode(ErrorCode.ConnectionDraining),
      );
    }
    this.draining = true;
    return this.protocol.drain();
  }

  isClosed(): boolean {
    return this.protocol.isClosed();
  }

  isDraining(): boolean {
    return this.draining;
  }

  getServer(): string {
    const srv = this.protocol.getServer();
    return srv ? srv.listen : "";
  }

  status(): AsyncIterable<Status> {
    const iter = new QueuedIteratorImpl<Status>();
    iter.iterClosed.then(() => {
      const idx = this.listeners.indexOf(iter);
      this.listeners.splice(idx, 1);
    });
    this.listeners.push(iter);
    return iter;
  }

  get info(): ServerInfo | undefined {
    return this.protocol.isClosed() ? undefined : this.protocol.info;
  }

  async context(): Promise<Context> {
    const r = await this.request(`$SYS.REQ.USER.INFO`);
    return r.json<Context>((key, value) => {
      if (key === "time") {
        return new Date(Date.parse(value));
      }
      return value;
    });
  }

  stats(): Stats {
    return {
      inBytes: this.protocol.inBytes,
      outBytes: this.protocol.outBytes,
      inMsgs: this.protocol.inMsgs,
      outMsgs: this.protocol.outMsgs,
    };
  }

  getServerVersion(): SemVer | undefined {
    const info = this.info;
    return info ? parseSemVer(info.version) : undefined;
  }

  async rtt(): Promise<number> {
    if (!this.protocol._closed && !this.protocol.connected) {
      throw NatsError.errorForCode(ErrorCode.Disconnect);
    }
    const start = Date.now();
    await this.flush();
    return Date.now() - start;
  }

  get features(): Features {
    return this.protocol.features;
  }

  reconnect(): Promise<void> {
    if (this.isClosed()) {
      return Promise.reject(
        NatsError.errorForCode(ErrorCode.ConnectionClosed),
      );
    }
    if (this.isDraining()) {
      return Promise.reject(
        NatsError.errorForCode(ErrorCode.ConnectionDraining),
      );
    }
    return this.protocol.reconnect();
  }
}
