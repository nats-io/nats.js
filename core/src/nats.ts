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
import { headers } from "./headers.ts";

import type { Features, SemVer } from "./semver.ts";
import { parseSemVer } from "./semver.ts";

import { parseOptions } from "./options.ts";
import { QueuedIteratorImpl } from "./queued_iterator.ts";
import type { RequestManyOptionsInternal } from "./request.ts";
import { RequestMany, RequestOne } from "./request.ts";

import type {
  ConnectionClosedListener,
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
import { createInbox } from "./core.ts";
import { errors, InvalidArgumentError, TimeoutError } from "./errors.ts";

const whitespaceRegex = /[ \n\r\t]/;

export class NatsConnectionImpl implements NatsConnection {
  options: ConnectionOptions;
  protocol!: ProtocolHandler;
  draining: boolean;
  closeListeners?: CloseListeners;

  private constructor(opts: ConnectionOptions) {
    this.draining = false;
    this.options = parseOptions(opts);
  }

  public static connect(opts: ConnectionOptions = {}): Promise<NatsConnection> {
    return new Promise<NatsConnection>((resolve, reject) => {
      const nc = new NatsConnectionImpl(opts);
      ProtocolHandler.connect(nc.options, nc)
        .then((ph: ProtocolHandler) => {
          nc.protocol = ph;
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
      throw new errors.ClosedConnectionError();
    }
    if (sub && this.isDraining()) {
      throw new errors.DrainingConnectionError();
    }
    if (pub && this.protocol.noMorePublishing) {
      throw new errors.DrainingConnectionError();
    }
    subject = subject || "";
    if (subject.length === 0 || whitespaceRegex.test(subject)) {
      throw new errors.InvalidSubjectError(subject);
    }
  }

  publish(
    subject: string,
    data?: Payload,
    options?: PublishOptions,
  ): void {
    this._check(subject, false, true);
    if (options?.reply) {
      this._check(options.reply, false, true);
    }

    if (typeof options?.traceOnly === "boolean") {
      const hdrs = options.headers || headers();
      hdrs.set("Nats-Trace-Only", "true");
      options.headers = hdrs;
    }
    if (typeof options?.traceDestination === "string") {
      const hdrs = options.headers || headers();
      hdrs.set("Nats-Trace-Dest", options.traceDestination);
      options.headers = hdrs;
    }

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

    if (typeof opts.callback !== "function" && typeof opts.slow === "number") {
      sub.setSlowNotificationFn(opts.slow, (pending: number) => {
        this.protocol.dispatchStatus({
          type: "slowConsumer",
          sub,
          pending,
        });
      });
    }
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

    opts.strategy = opts.strategy || "timer";
    opts.maxWait = opts.maxWait || 1000;
    if (opts.maxWait < 1) {
      return Promise.reject(
        InvalidArgumentError.format("timeout", "must be greater than 0"),
      );
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
            msg?.headers?.status === "503"
          ) {
            err = new errors.NoRespondersError(subject);
          }
          // augment any error with the current stack to provide context
          // for the error in the user code
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
          if (opts.strategy === "count") {
            max--;
            if (max === 0) {
              cancel();
            }
          }
          if (opts.strategy === "stall") {
            clearTimers();
            timer = setTimeout(() => {
              cancel();
            }, 300);
          }
          if (opts.strategy === "sentinel") {
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

      const { headers, traceDestination, traceOnly } = opts;
      try {
        this.publish(subject, data, {
          reply: sub.getSubject(),
          headers,
          traceDestination,
          traceOnly,
        });
      } catch (err) {
        cancel(err as Error);
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

      const { headers, traceDestination, traceOnly } = opts;

      try {
        this.publish(
          subject,
          data,
          {
            reply: `${this.protocol.muxSubscriptions.baseInbox}${r.token}`,
            headers,
            traceDestination,
            traceOnly,
          },
        );
      } catch (err) {
        r.cancel(err as Error);
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
      return Promise.reject(
        InvalidArgumentError.format("timeout", `must be greater than 0`),
      );
    }
    if (!opts.noMux && opts.reply) {
      return Promise.reject(
        InvalidArgumentError.format(
          ["reply", "noMux"],
          "are mutually exclusive",
        ),
      );
    }

    if (opts.noMux) {
      const inbox = opts.reply
        ? opts.reply
        : createInbox(this.options.inboxPrefix);
      const d = deferred<Msg>();
      const errCtx = asyncTraces ? new errors.RequestError("") : null;
      const sub = this.subscribe(
        inbox,
        {
          max: 1,
          timeout: opts.timeout,
          callback: (err, msg) => {
            // check for no responders status
            if (msg && msg.data?.length === 0 && msg.headers?.code === 503) {
              err = new errors.NoRespondersError(subject);
            }
            if (err) {
              // we have a proper stack on timeout
              if (!(err instanceof TimeoutError)) {
                if (errCtx) {
                  errCtx.message = err.message;
                  errCtx.cause = err;
                  err = errCtx;
                } else {
                  err = new errors.RequestError(err.message, { cause: err });
                }
              }
              d.reject(err);
              sub.unsubscribe();
            } else {
              d.resolve(msg);
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

      const { headers, traceDestination, traceOnly } = opts;

      try {
        this.publish(
          subject,
          data,
          {
            reply: `${this.protocol.muxSubscriptions.baseInbox}${r.token}`,
            headers,
            traceDestination,
            traceOnly,
          },
        );
      } catch (err) {
        r.cancel(err as Error);
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
      return Promise.reject(new errors.ClosedConnectionError());
    }
    return this.protocol.flush();
  }

  drain(): Promise<void> {
    if (this.isClosed()) {
      return Promise.reject(new errors.ClosedConnectionError());
    }
    if (this.isDraining()) {
      return Promise.reject(new errors.DrainingConnectionError());
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
      const idx = this.protocol.listeners.indexOf(iter);
      if (idx > -1) {
        this.protocol.listeners.splice(idx, 1);
      }
    });
    this.protocol.listeners.push(iter);
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
    if (this.isClosed()) {
      throw new errors.ClosedConnectionError();
    }
    if (!this.protocol.connected) {
      throw new errors.RequestError("connection disconnected");
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
      return Promise.reject(new errors.ClosedConnectionError());
    }
    if (this.isDraining()) {
      return Promise.reject(new errors.DrainingConnectionError());
    }
    return this.protocol.reconnect();
  }

  // internal
  addCloseListener(listener: ConnectionClosedListener) {
    if (this.closeListeners === undefined) {
      this.closeListeners = new CloseListeners(this.closed());
    }
    this.closeListeners.add(listener);
  }
  // internal
  removeCloseListener(listener: ConnectionClosedListener) {
    if (this.closeListeners) {
      this.closeListeners.remove(listener);
    }
  }
}

class CloseListeners {
  listeners: ConnectionClosedListener[];

  constructor(closed: Promise<void | Error>) {
    this.listeners = [];
    closed.then((err) => {
      this.notify(err);
    });
  }

  add(listener: ConnectionClosedListener) {
    this.listeners.push(listener);
  }

  remove(listener: ConnectionClosedListener) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  notify(err: void | Error) {
    this.listeners.forEach((l) => {
      if (typeof l.connectionClosedCallback === "function") {
        try {
          l.connectionClosedCallback(err);
        } catch (_) {
          // ignored
        }
      }
    });
    this.listeners = [];
  }
}
