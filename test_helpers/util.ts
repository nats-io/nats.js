/*
 * Copyright 2020-2024 The NATS Authors
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
import { deferred, timeout } from "../core/src/internal_mod.ts";
import { assert } from "jsr:@std/assert";

export function consume<T>(iter: Iterable<T>, ms = 1000): Promise<T[]> {
  const to = timeout<T[]>(ms);
  const d = deferred<T[]>();
  const msgs: T[] = [];
  (async () => {
    for await (const m of iter) {
      msgs.push(m);
    }
    to.cancel();
    d.resolve(msgs);
  })().catch((err) => {
    d.reject(err);
  });

  return Promise.race([to, d]);
}

export function time(): Mark {
  return new Mark();
}

export class Mark {
  measures: [number, number][];
  constructor() {
    this.measures = [];
    this.measures.push([Date.now(), 0]);
  }

  mark() {
    const now = Date.now();
    const idx = this.measures.length - 1;
    if (this.measures[idx][1] === 0) {
      this.measures[idx][1] = now;
    } else {
      this.measures.push([now, 0]);
    }
  }

  duration(): number {
    const idx = this.measures.length - 1;
    if (this.measures[idx][1] === 0) {
      this.measures.pop();
    }
    const times = this.measures.map((v) => v[1] - v[0]);
    return times.reduce((result, item) => {
      return result + item;
    });
  }

  assertLess(target: number) {
    const d = this.duration();
    assert(
      target >= d,
      `duration ${d} not in range - ${target} ≥ ${d}`,
    );
  }

  assertInRange(target: number) {
    const min = .50 * target;
    const max = 1.50 * target;
    const d = this.duration();
    assert(
      d >= min && max >= d,
      `duration ${d} not in range - ${min} ≥ ${d} && ${max} ≥ ${d}`,
    );
  }
}
