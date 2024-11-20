/*
 * Copyright 2020-2023 The NATS Authors
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
import type { Deferred, Timeout } from "./util.ts";
import { deferred, timeout } from "./util.ts";
import type { MuxSubscription } from "./muxsubscription.ts";
import { nuid } from "./nuid.ts";
import type {
  Msg,
  Request,
  RequestManyOptions,
  RequestOptions,
} from "./core.ts";
import { errors, RequestError, TimeoutError } from "./errors.ts";

export class BaseRequest {
  token: string;
  received: number;
  ctx?: RequestError;
  requestSubject: string;
  mux: MuxSubscription;

  constructor(
    mux: MuxSubscription,
    requestSubject: string,
    asyncTraces = true,
  ) {
    this.mux = mux;
    this.requestSubject = requestSubject;
    this.received = 0;
    this.token = nuid.next();
    if (asyncTraces) {
      this.ctx = new RequestError();
    }
  }
}

export interface RequestManyOptionsInternal extends RequestManyOptions {
  callback: (err: Error | null, msg: Msg | null) => void;
}

/**
 * Request expects multiple message response
 * the request ends when the timer expires,
 * an error arrives or an expected count of messages
 * arrives, end is signaled by a null message
 */
export class RequestMany extends BaseRequest implements Request {
  callback!: (err: Error | null, msg: Msg | null) => void;
  done: Deferred<void>;
  timer: number;
  max: number;
  opts: Partial<RequestManyOptionsInternal>;
  constructor(
    mux: MuxSubscription,
    requestSubject: string,
    opts: Partial<RequestManyOptions> = { maxWait: 1000 },
  ) {
    super(mux, requestSubject);
    this.opts = opts;
    if (typeof this.opts.callback !== "function") {
      throw new TypeError("callback must be a function");
    }
    this.callback = this.opts.callback;

    this.max = typeof opts.maxMessages === "number" && opts.maxMessages > 0
      ? opts.maxMessages
      : -1;
    this.done = deferred();
    this.done.then(() => {
      this.callback(null, null);
    });
    // @ts-ignore: node is not a number
    this.timer = setTimeout(() => {
      this.cancel();
    }, opts.maxWait);
  }

  cancel(err?: Error): void {
    if (err) {
      this.callback(err, null);
    }
    clearTimeout(this.timer);
    this.mux.cancel(this);
    this.done.resolve();
  }

  resolver(err: Error | null, msg: Msg): void {
    if (err) {
      if (this.ctx) {
        err.stack += `\n\n${this.ctx.stack}`;
      }
      this.cancel(err as Error);
    } else {
      this.callback(null, msg);
      if (this.opts.strategy === "count") {
        this.max--;
        if (this.max === 0) {
          this.cancel();
        }
      }

      if (this.opts.strategy === "stall") {
        clearTimeout(this.timer);
        // @ts-ignore: node is not a number
        this.timer = setTimeout(() => {
          this.cancel();
        }, this.opts.stall || 300);
      }

      if (this.opts.strategy === "sentinel") {
        if (msg && msg.data.length === 0) {
          this.cancel();
        }
      }
    }
  }
}

export class RequestOne extends BaseRequest implements Request {
  deferred: Deferred<Msg>;
  timer: Timeout<Msg>;

  constructor(
    mux: MuxSubscription,
    requestSubject: string,
    opts: RequestOptions = { timeout: 1000 },
    asyncTraces = true,
  ) {
    super(mux, requestSubject, asyncTraces);
    // extend(this, opts);
    this.deferred = deferred();
    this.timer = timeout<Msg>(opts.timeout, asyncTraces);
  }

  resolver(err: Error | null, msg: Msg): void {
    if (this.timer) {
      this.timer.cancel();
    }
    if (err) {
      // we have proper stack on timeout
      if (!(err instanceof TimeoutError)) {
        if (this.ctx) {
          this.ctx.message = err.message;
          this.ctx.cause = err;
          err = this.ctx;
        } else {
          err = new errors.RequestError(err.message, { cause: err });
        }
      }
      this.deferred.reject(err);
    } else {
      this.deferred.resolve(msg);
    }
    this.cancel();
  }

  cancel(err?: Error): void {
    if (this.timer) {
      this.timer.cancel();
    }
    this.mux.cancel(this);
    this.deferred.reject(
      err ? err : new RequestError("cancelled"),
    );
  }
}
