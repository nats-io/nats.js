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
import { assert, assertEquals, fail } from "@std/assert";

import { deferred, delay, Heartbeat } from "../src/internal_mod.ts";
import type { PH, Status } from "../src/internal_mod.ts";

function pm(
  lag: number,
  disconnect: () => void,
  statusHandler: (s: Status) => void,
  skip?: number[],
): PH {
  let counter = 0;
  return {
    flush(): Promise<void> {
      counter++;
      const d = deferred<void>();
      if (skip && skip.indexOf(counter) !== -1) {
        return d;
      }
      delay(lag)
        .then(() => d.resolve());
      return d;
    },
    disconnect(): void {
      disconnect();
    },
    dispatchStatus(status: Status): void {
      statusHandler(status);
    },
  };
}
Deno.test("heartbeat - timers fire", async () => {
  const status: Status[] = [];
  const ph = pm(25, () => {
    fail("shouldn't have disconnected");
  }, (s: Status): void => {
    status.push(s);
  });

  const hb = new Heartbeat(ph, 100, 3);
  hb._schedule();
  await delay(400);
  assert(hb.timer);
  hb.cancel();
  // we can have a timer still running here - we need to wait for lag
  await delay(50);
  assertEquals(hb.timer, undefined);
  assert(status.length >= 2, `status ${status.length} >= 2`);
  assertEquals(status[0].type, "ping");
});

Deno.test("heartbeat - errors fire on missed maxOut", async () => {
  const disconnect = deferred<void>();
  const status: Status[] = [];
  const ph = pm(25, () => {
    disconnect.resolve();
  }, (s: Status): void => {
    status.push(s);
  }, [4, 5, 6]);

  const hb = new Heartbeat(ph, 100, 3);
  hb._schedule();
  await disconnect;
  assertEquals(hb.timer, undefined);
  assert(status.length >= 7, `${status.length} >= 7`);
  assertEquals(status[0].type, "ping");
});

Deno.test("heartbeat - recovers from missed", async () => {
  let maxPending = 0;
  const d = deferred<void>();
  const ph = pm(25, () => {
    fail("shouldn't have disconnected");
  }, (s: Status): void => {
    if (s.type === "ping") {
      // increase it
      if (s.pendingPings >= maxPending) {
        maxPending = s.pendingPings;
      } else {
        // if lower it recovered
        d.resolve();
      }
    }
  }, [4, 5]);

  const hb = new Heartbeat(ph, 100, 3);
  hb._schedule();
  await d;
  hb.cancel();
  // some resources in the test runner are not always cleaned unless we wait a bit
  await delay(500);
});
