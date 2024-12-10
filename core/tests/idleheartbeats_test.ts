/*
 * Copyright 2022-2023 The NATS Authors
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

import { deferred, IdleHeartbeatMonitor } from "../src/internal_mod.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from "jsr:@std/assert";

Deno.test("idleheartbeat - basic", async () => {
  const d = deferred<number>();
  const h = new IdleHeartbeatMonitor(250, () => {
    d.reject(new Error("didn't expect to notify"));
    return true;
  });
  let count = 0;
  const timer = setInterval(() => {
    count++;
    h.work();
    if (count === 8) {
      clearInterval(timer);
      h.cancel();
      d.resolve();
    }
  }, 100);

  await d;
});

Deno.test("idleheartbeat - timeout", async () => {
  const d = deferred<number>();
  new IdleHeartbeatMonitor(250, (v: number): boolean => {
    d.resolve(v);
    return true;
  }, { maxOut: 1 });
  assertEquals(await d, 1);
});

Deno.test("idleheartbeat - timeout maxOut", async () => {
  const d = deferred<number>();
  new IdleHeartbeatMonitor(250, (v: number): boolean => {
    d.resolve(v);
    return true;
  }, { maxOut: 5 });
  assertEquals(await d, 5);
});

Deno.test("idleheartbeat - timeout recover", async () => {
  const d = deferred<void>();
  const h = new IdleHeartbeatMonitor(250, (_v: number): boolean => {
    d.reject(new Error("didn't expect to fail"));
    return true;
  }, { maxOut: 5 });

  setTimeout(() => {
    h.cancel();
    d.resolve();
    clearInterval(interval);
  }, 1730);

  const interval = setInterval(() => {
    h.work();
  }, 1000);

  await d;
  assert(4 >= h.missed, `4 >= ${h.missed}`);
});

Deno.test("idleheartbeat - timeout autocancel", async () => {
  const d = deferred();
  const h = new IdleHeartbeatMonitor(250, (_v: number): boolean => {
    d.reject(new Error("didn't expect to fail"));
    return true;
  }, { maxOut: 4, cancelAfter: 2000 });

  assert(h.autoCancelTimer);

  let t = 0;
  const timer = setInterval(() => {
    h.work();
    t++;
    if (t === 20) {
      clearInterval(timer);
      d.resolve();
    }
  }, 100);

  // we are not canceling the monitor, as the test will catch
  // and resource leaks for a timer if not cleared.

  await d;
  assertEquals(h.cancelAfter, 2000);
  assertEquals(h.timer, 0);
  assertEquals(h.autoCancelTimer, 0);
  assert(h.count >= 6, `${h.count} >= 6`);
});

Deno.test("idleheartbeat - change", () => {
  const h = new IdleHeartbeatMonitor(2000, (_v: number): boolean => {
    return true;
  }, { maxOut: 2, cancelAfter: 2000 });

  assertEquals(h.cancelAfter, 2000);
  assertEquals(h.maxOut, 2);
  assertEquals(h.interval, 2000);
  assertExists(h.timer);
  const old = h.timer;

  h._change(3000, 3000, 4);
  assertEquals(h.cancelAfter, 3000);
  assertEquals(h.maxOut, 4);
  assertEquals(h.interval, 3000);
  assertNotEquals(old, h.timer);

  h.cancel();
});

Deno.test("idleheartbeat - restart", () => {
  const h = new IdleHeartbeatMonitor(2000, (_v: number): boolean => {
    return true;
  }, { maxOut: 2, cancelAfter: 2000 });

  assertExists(h.timer);
  const old = h.timer;

  h.restart();
  assertExists(h.timer);
  assertNotEquals(old, h.timer);

  h.cancel();
});
