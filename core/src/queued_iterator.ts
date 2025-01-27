/*
 * Copyright 2020-2022 The NATS Authors
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
import type { Deferred } from "./util.ts";
import { deferred } from "./util.ts";
import type { QueuedIterator } from "./core.ts";
import type { CallbackFn, Dispatcher } from "./core.ts";
import { InvalidOperationError } from "./errors.ts";

export class QueuedIteratorImpl<T> implements QueuedIterator<T>, Dispatcher<T> {
  inflight: number;
  processed: number;
  // this is updated by the protocol
  received: number;
  noIterator: boolean;
  iterClosed: Deferred<void | Error>;
  done: boolean;
  signal: Deferred<void>;
  yields: (T | CallbackFn)[];
  filtered: number;
  pendingFiltered: number;
  ctx?: unknown;
  _data?: unknown; //data is for use by extenders in any way they like
  err?: Error;
  time: number;
  profile: boolean;
  yielding: boolean;
  didBreak: boolean;

  constructor() {
    this.inflight = 0;
    this.filtered = 0;
    this.pendingFiltered = 0;
    this.processed = 0;
    this.received = 0;
    this.noIterator = false;
    this.done = false;
    this.signal = deferred<void>();
    this.yields = [];
    this.iterClosed = deferred<void | Error>();
    this.time = 0;
    this.yielding = false;
    this.didBreak = false;
    this.profile = false;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.iterate();
  }

  push(v: T | CallbackFn): void {
    if (this.done) {
      return;
    }
    // if they `break` from a `for await`, any signaling that is pushed via
    // a function is not handled this can prevent closed promises from
    // resolving downstream.
    if (this.didBreak) {
      if (typeof v === "function") {
        const cb = v as CallbackFn;
        try {
          cb();
        } catch (_) {
          // ignored
        }
      }
      return;
    }
    if (typeof v === "function") {
      this.pendingFiltered++;
    }
    this.yields.push(v);
    this.signal.resolve();
  }

  async *iterate(): AsyncIterableIterator<T> {
    if (this.noIterator) {
      throw new InvalidOperationError(
        "iterator cannot be used when a callback is registered",
      );
    }
    if (this.yielding) {
      throw new InvalidOperationError("iterator is already yielding");
    }
    this.yielding = true;
    try {
      while (true) {
        if (this.yields.length === 0) {
          await this.signal;
        }
        if (this.err) {
          throw this.err;
        }
        const yields = this.yields;
        this.inflight = yields.length;
        this.yields = [];
        for (let i = 0; i < yields.length; i++) {
          if (typeof yields[i] === "function") {
            this.pendingFiltered--;
            const fn = yields[i] as CallbackFn;
            try {
              fn();
            } catch (err) {
              // failed on the invocation - fail the iterator
              // so they know to fix the callback
              throw err;
            }
            // fn could have also set an error
            if (this.err) {
              throw this.err;
            }
            continue;
          }

          this.processed++;
          this.inflight--;
          const start = this.profile ? Date.now() : 0;
          yield yields[i] as T;
          this.time = this.profile ? Date.now() - start : 0;
        }
        // yielding could have paused and microtask
        // could have added messages. Prevent allocations
        // if possible
        if (this.done) {
          break;
        } else if (this.yields.length === 0) {
          yields.length = 0;
          this.yields = yields;
          this.signal = deferred();
        }
      }
    } finally {
      // the iterator used break/return
      this.didBreak = true;
      this.stop();
    }
  }

  stop(err?: Error): void {
    if (this.done) {
      return;
    }
    this.err = err;
    this.done = true;
    this.signal.resolve();
    this.iterClosed.resolve(err);
  }

  getProcessed(): number {
    return this.noIterator ? this.received : this.processed;
  }

  getPending(): number {
    return this.yields.length + this.inflight - this.pendingFiltered;
  }

  getReceived(): number {
    return this.received - this.filtered;
  }
}
