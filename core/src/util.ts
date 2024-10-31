/*
 * Copyright 2018-2024 The NATS Authors
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
// deno-lint-ignore-file no-explicit-any
import { TD } from "./encoders.ts";
import type { Nanos } from "./core.ts";
import { TimeoutError } from "./errors.ts";

export type ValueResult<T> = {
  isError: false;
  value: T;
};

export type ErrorResult = {
  isError: true;
  error: Error;
};

/**
 * Result is a value that may have resulted in an error.
 */
export type Result<T> = ValueResult<T> | ErrorResult;

export function extend(a: any, ...b: any[]): any {
  for (let i = 0; i < b.length; i++) {
    const o = b[i];
    Object.keys(o).forEach(function (k) {
      a[k] = o[k];
    });
  }
  return a;
}

export interface Pending {
  pending: number;
  write: (c: number) => void;
  wrote: (c: number) => void;
  err: (err: Error) => void;
  close: () => void;
  promise: () => Promise<any>;
  resolved: boolean;
  done: boolean;
}

export function render(frame: Uint8Array): string {
  const cr = "␍";
  const lf = "␊";
  return TD.decode(frame)
    .replace(/\n/g, lf)
    .replace(/\r/g, cr);
}

export interface Timeout<T> extends Promise<T> {
  cancel: () => void;
}

export function timeout<T>(ms: number, asyncTraces = true): Timeout<T> {
  // by generating the stack here to help identify what timed out
  const err = asyncTraces ? new TimeoutError() : null;
  let methods;
  let timer: number;
  const p = new Promise((_resolve, reject) => {
    const cancel = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
    };
    methods = { cancel };
    // @ts-ignore: node is not a number
    timer = setTimeout(() => {
      if (err === null) {
        reject(new TimeoutError());
      } else {
        reject(err);
      }
    }, ms);
  });
  // noinspection JSUnusedAssignment
  return Object.assign(p, methods) as Timeout<T>;
}

export interface Delay extends Promise<void> {
  cancel: () => void;
}

export function delay(ms = 0): Delay {
  let methods;
  const p = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      resolve();
    }, ms);
    const cancel = (): void => {
      if (timer) {
        clearTimeout(timer);
        resolve();
      }
    };
    methods = { cancel };
  });
  return Object.assign(p, methods) as Delay;
}

export async function deadline<T>(p: Promise<T>, millis = 1000): Promise<T> {
  const d = deferred<never>();
  const timer = setTimeout(
    () => {
      d.reject(new TimeoutError());
    },
    millis,
  );
  try {
    return await Promise.race([p, d]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Deferred<T> extends Promise<T> {
  /**
   * Resolves the Deferred to a value T
   * @param value
   */
  resolve: (value?: T | PromiseLike<T>) => void;
  //@ts-ignore: tsc guard
  /**
   * Rejects the Deferred
   * @param reason
   */
  reject: (reason?: any) => void;
}

/**
 * Returns a Promise that has a resolve/reject methods that can
 * be used to resolve and defer the Deferred.
 */
export function deferred<T>(): Deferred<T> {
  let methods = {};
  const p = new Promise<T>((resolve, reject): void => {
    methods = { resolve, reject };
  });
  return Object.assign(p, methods) as Deferred<T>;
}

export function debugDeferred<T>(): Deferred<T> {
  let methods = {};
  const p = new Promise<T>((resolve, reject): void => {
    methods = {
      resolve: (v: T) => {
        console.trace("resolve", v);
        resolve(v);
      },
      reject: (err?: Error) => {
        console.trace("reject");
        reject(err);
      },
    };
  });
  return Object.assign(p, methods) as Deferred<T>;
}

export function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const buf: T[] = [];
  for await (const v of iter) {
    buf.push(v);
  }
  return buf;
}

export class Perf {
  timers: Map<string, number>;
  measures: Map<string, number>;

  constructor() {
    this.timers = new Map();
    this.measures = new Map();
  }

  mark(key: string) {
    this.timers.set(key, performance.now());
  }

  measure(key: string, startKey: string, endKey: string) {
    const s = this.timers.get(startKey);
    if (s === undefined) {
      throw new Error(`${startKey} is not defined`);
    }
    const e = this.timers.get(endKey);
    if (e === undefined) {
      throw new Error(`${endKey} is not defined`);
    }
    this.measures.set(key, e - s);
  }

  getEntries(): { name: string; duration: number }[] {
    const values: { name: string; duration: number }[] = [];
    this.measures.forEach((v, k) => {
      values.push({ name: k, duration: v });
    });
    return values;
  }
}

export class SimpleMutex {
  max: number;
  current: number;
  waiting: Deferred<void>[];

  /**
   * @param max number of concurrent operations
   */
  constructor(max = 1) {
    this.max = max;
    this.current = 0;
    this.waiting = [];
  }

  /**
   * Returns a promise that resolves when the mutex is acquired
   */
  lock(): Promise<void> {
    // increment the count
    this.current++;
    // if we have runners, resolve it
    if (this.current <= this.max) {
      return Promise.resolve();
    }
    // otherwise defer it
    const d = deferred<void>();
    this.waiting.push(d);
    return d;
  }

  /**
   * Release an acquired mutex - must be called
   */
  unlock(): void {
    // decrement the count
    this.current--;
    // if we have deferred, resolve one
    const d = this.waiting.pop();
    d?.resolve();
  }
}

/**
 * Returns a new number between  .5*n and 1.5*n.
 * If the n is 0, returns 0.
 * @param n
 */
export function jitter(n: number): number {
  if (n === 0) {
    return 0;
  }
  return Math.floor(n / 2 + Math.random() * n);
}

export interface Backoff {
  backoff(attempt: number): number;
}

/**
 * Returns a Backoff with the specified interval policy set.
 * @param policy
 */
export function backoff(policy = [0, 250, 250, 500, 500, 3000, 5000]): Backoff {
  if (!Array.isArray(policy)) {
    policy = [0, 250, 250, 500, 500, 3000, 5000];
  }
  const max = policy.length - 1;
  return {
    backoff(attempt: number): number {
      return jitter(attempt > max ? policy[max] : policy[attempt]);
    },
  };
}

/**
 * Converts the specified millis into Nanos
 * @param millis
 */
export function nanos(millis: number): Nanos {
  return millis * 1000000;
}

/**
 * Convert the specified Nanos into millis
 * @param ns
 */
export function millis(ns: Nanos): number {
  return Math.floor(ns / 1000000);
}
