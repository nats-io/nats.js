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
import { deferred, randomToken, timeout } from "./util.ts";
import type { MuxSubscription } from "./muxsubscription.ts";
import type {
  Msg,
  Request,
  RequestManyOptions,
  RequestOptions,
  SentinelFn,
} from "./core.ts";
import {
  errors,
  NoRespondersError,
  RequestError,
  TimeoutError,
} from "./errors.ts";

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
    this.token = randomToken();
    if (asyncTraces) {
      this.ctx = new RequestError();
    }
  }
}

export interface RequestManyOptionsInternal extends RequestManyOptions {
  callback: (err: Error | null, msg: Msg | null) => void;
}

/**
 * Returns the stall timeout for the request, or 0 if responses don't
 * reset the timer.
 */
function stallTimeout(opts: Partial<RequestManyOptions>): number {
  if (typeof opts.stall === "number" && opts.stall > 0) {
    return opts.stall;
  }
  return opts.strategy === "stall" ? 300 : 0;
}

/**
 * Returns a function that is called with each response after it is
 * delivered. It returns true if the request should continue, false
 * if it is done, or an Error if it is done with an error.
 */
function requestManyStrategy(
  opts: Partial<RequestManyOptions>,
): SentinelFn {
  const strategy = opts.strategy;
  if (typeof strategy === "function") {
    return guard([strategy]);
  }
  if (Array.isArray(strategy)) {
    return guard(strategy);
  }
  switch (strategy) {
    case "count": {
      let max = typeof opts.maxMessages === "number" && opts.maxMessages > 0
        ? opts.maxMessages
        : -1;
      return () => {
        max--;
        return max !== 0;
      };
    }
    case "sentinel":
      return (msg) => msg.data.length > 0;
    default:
      return () => true;
  }
}

// runs the user's functions in order, the first that doesn't continue
// ends the request - a function that throws ends it with the error
function guard(fns: SentinelFn[]): SentinelFn {
  return (msg) => {
    for (const fn of fns) {
      let r: boolean | Error;
      try {
        r = fn(msg);
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
      if (r === false || r instanceof Error) {
        return r;
      }
    }
    return true;
  };
}

// a condition that ends a request many: timers are armed by start(),
// msg() is called with every response after it is delivered
interface Ender {
  start(end: (err?: Error) => void): void;
  msg(m: Msg): boolean | Error;
  stop(): void;
}

// "max" ends the request when it expires, "first" fails it if no
// response arrives in time, "stall" ends it if no response follows
// the previous one in time
class TimerEnder implements Ender {
  ms: number;
  mode: "max" | "first" | "stall";
  err?: () => Error;
  timer?: ReturnType<typeof setTimeout>;
  end!: (err?: Error) => void;

  constructor(
    ms: number,
    mode: "max" | "first" | "stall",
    err?: () => Error,
  ) {
    this.ms = ms;
    this.mode = mode;
    this.err = err;
  }

  start(end: (err?: Error) => void): void {
    this.end = end;
    if (this.mode !== "stall") {
      this.arm();
    }
  }

  msg(): boolean {
    if (this.mode === "first") {
      this.stop();
    } else if (this.mode === "stall") {
      this.arm();
    }
    return true;
  }

  arm(): void {
    this.stop();
    this.timer = setTimeout(() => {
      this.end(this.err?.());
    }, this.ms);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

class CheckEnder implements Ender {
  fn: SentinelFn;
  constructor(fn: SentinelFn) {
    this.fn = fn;
  }
  start(): void {}
  msg(m: Msg): boolean | Error {
    return this.fn(m);
  }
  stop(): void {}
}

/**
 * Tracks the conditions that end a request many: maxWait (unless
 * Infinity), timeout, stall and the strategy. The first to end the
 * request stops all of them and calls onEnd, once.
 */
export class RequestManyEnd {
  enders: Ender[];
  done: boolean;
  onEnd: (err?: Error) => void;

  constructor(
    opts: Partial<RequestManyOptions>,
    onEnd: (err?: Error) => void,
    asyncTraces = true,
  ) {
    this.onEnd = onEnd;
    this.done = false;
    this.enders = [];
    const maxWait = opts.maxWait ?? 1000;
    if (Number.isFinite(maxWait)) {
      this.enders.push(new TimerEnder(maxWait, "max"));
    }
    if (typeof opts.timeout === "number" && opts.timeout > 0) {
      // with async traces created here so its stack is the caller's
      const err = asyncTraces ? new TimeoutError() : undefined;
      this.enders.push(
        new TimerEnder(opts.timeout, "first", () => err || new TimeoutError()),
      );
    }
    // as ADR-47, a stall that can't fire before maxWait is ignored
    const stall = stallTimeout(opts);
    if (stall && stall < maxWait) {
      this.enders.push(new TimerEnder(stall, "stall"));
    }
    this.enders.push(new CheckEnder(requestManyStrategy(opts)));
  }

  start(): void {
    for (const e of this.enders) {
      e.start((err) => this.end(err));
    }
  }

  msg(m: Msg): void {
    for (const e of this.enders) {
      if (this.done) {
        return;
      }
      const r = e.msg(m);
      if (r !== true) {
        this.end(r === false ? undefined : r);
        return;
      }
    }
  }

  end(err?: Error): void {
    if (this.done) {
      return;
    }
    this.stop();
    this.onEnd(err);
  }

  stop(): void {
    this.done = true;
    for (const e of this.enders) {
      e.stop();
    }
  }
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
  end: RequestManyEnd;
  opts: Partial<RequestManyOptionsInternal>;
  noResponders?: NoRespondersError;
  constructor(
    mux: MuxSubscription,
    requestSubject: string,
    opts: Partial<RequestManyOptions> = { maxWait: 1000 },
    asyncTraces = true,
  ) {
    super(mux, requestSubject, asyncTraces);
    if (this.ctx) {
      // created here so its stack is the caller's
      this.noResponders = new NoRespondersError(requestSubject);
    }
    this.opts = opts;
    if (typeof this.opts.callback !== "function") {
      throw new TypeError("callback must be a function");
    }
    this.callback = this.opts.callback;

    this.done = deferred();
    this.done.then(() => {
      this.callback(null, null);
    });
    this.end = new RequestManyEnd(opts, (err) => {
      this.cancel(err);
    }, asyncTraces);
    this.end.start();
  }

  cancel(err?: Error): void {
    if (err) {
      this.callback(err, null);
    }
    this.end.stop();
    this.mux.cancel(this);
    this.done.resolve();
  }

  resolver(err: Error | null, msg: Msg): void {
    if (err) {
      // other errors are not ours to modify, they can be shared
      if (err instanceof NoRespondersError && this.noResponders) {
        err = this.noResponders;
      }
      this.cancel(err as Error);
    } else {
      this.callback(null, msg);
      this.end.msg(msg);
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
