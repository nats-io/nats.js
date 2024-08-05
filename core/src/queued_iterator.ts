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
import { ErrorCode, NatsError } from "./core.ts";
import type { CallbackFn, Dispatcher } from "./core.ts";

export type IngestionFilterFnResult = { ingest: boolean; protocol: boolean };

/**
 * IngestionFilterFn prevents a value from being ingested by the
 * iterator. It is executed on `push`. If ingest is false the value
 * shouldn't be pushed. If protcol is true, the value is a protcol
 * value
 *
 * @param: data is the value
 * @src: is the source of the data if set.
 */
export type IngestionFilterFn<T = unknown> = (
  data: T | null,
  src?: unknown,
) => IngestionFilterFnResult;
/**
 * ProtocolFilterFn allows filtering of values that shouldn't be presented
 * to the iterator. ProtocolFilterFn is executed when a value is about to be presented
 *
 * @param data: the value
 * @returns boolean: true if the value should presented to the iterator
 */
export type ProtocolFilterFn<T = unknown> = (data: T | null) => boolean;
/**
 * DispatcherFn allows for values to be processed after being presented
 * to the iterator. Note that if the ProtocolFilter rejected the value
 * it will _not_ be presented to the DispatchedFn. Any processing should
 * instead have been handled by the ProtocolFilterFn.
 * @param data: the value
 */
export type DispatchedFn<T = unknown> = (data: T | null) => void;

export class QueuedIteratorImpl<T> implements QueuedIterator<T>, Dispatcher<T> {
  inflight: number;
  processed: number;
  // FIXME: this is updated by the protocol
  received: number;
  noIterator: boolean;
  iterClosed: Deferred<void | Error>;
  done: boolean;
  signal: Deferred<void>;
  yields: (T | CallbackFn)[];
  filtered: number;
  pendingFiltered: number;
  ingestionFilterFn?: IngestionFilterFn<T>;
  protocolFilterFn?: ProtocolFilterFn<T>;
  dispatchedFn?: DispatchedFn<T>;
  ctx?: unknown;
  _data?: unknown; //data is for use by extenders in any way they like
  err?: Error;
  time: number;
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
      this.yields.push(v);
      this.signal.resolve();
      return;
    }
    const { ingest, protocol } = this.ingestionFilterFn
      ? this.ingestionFilterFn(v, this.ctx || this)
      : { ingest: true, protocol: false };
    if (ingest) {
      if (protocol) {
        this.filtered++;
        this.pendingFiltered++;
      }
      this.yields.push(v);
      this.signal.resolve();
    }
  }

  async *iterate(): AsyncIterableIterator<T> {
    if (this.noIterator) {
      throw new NatsError("unsupported iterator", ErrorCode.ApiError);
    }
    if (this.yielding) {
      throw new NatsError("already yielding", ErrorCode.ApiError);
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
          // only pass messages that pass the filter
          const ok = this.protocolFilterFn
            ? this.protocolFilterFn(yields[i] as T)
            : true;
          if (ok) {
            this.processed++;
            const start = Date.now();
            yield yields[i] as T;
            this.time = Date.now() - start;
            if (this.dispatchedFn && yields[i]) {
              this.dispatchedFn(yields[i] as T);
            }
          } else {
            this.pendingFiltered--;
          }
          this.inflight--;
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
