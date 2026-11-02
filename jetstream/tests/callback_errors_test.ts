/*
 * Copyright 2026 The NATS Authors
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

import { cleanup, jetstreamServerConf, notCompatible, setup } from "nst";
import { assert, assertEquals } from "@std/assert";
import { deadline, deferred, delay, errors } from "@nats-io/nats-core/internal";
import type {
  NatsConnection,
  UnhandledCallbackError,
} from "@nats-io/nats-core/internal";
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
} from "../src/mod.ts";
import type { ConsumerCallbackFn, JsMsg, StoredMsg } from "../src/mod.ts";

// captures the callback errors printed with console.error, until restored
// or disposed, so a failing test doesn't leave it patched
function capturePrinted(): {
  errors: UnhandledCallbackError[];
  restore: () => void;
  [Symbol.dispose]: () => void;
} {
  const found: UnhandledCallbackError[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    const e = args[0];
    if (e instanceof errors.UnhandledCallbackError) {
      found.push(e);
    } else {
      orig(...args);
    }
  };
  const restore = () => {
    console.error = orig;
  };
  return { errors: found, restore, [Symbol.dispose]: restore };
}

async function stream(nc: NatsConnection): Promise<void> {
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"], allow_direct: true });
  const js = jetstream(nc);
  await js.publish("a", "1");
  await js.publish("a", "2");
}

Deno.test("callback errors - a failing consume callback is printed and the consumer continues", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  await stream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add("A", {
    durable_name: "c",
    ack_policy: AckPolicy.Explicit,
    ack_wait: 1_000_000_000,
  });
  using printed = capturePrinted();

  // the first delivery of "1" fails, sync or async, the message isn't acked
  // and is redelivered, "2" is processed in between
  const boom = new Error("boom");
  const got: string[] = [];
  const done = deferred<void>();
  const js = jetstream(nc);
  const c = await js.consumers.get("A", "c");
  const iter = await c.consume({
    callback: ((m: JsMsg) => {
      got.push(`${m.string()}:${m.info.deliveryCount}`);
      if (m.string() === "1" && m.info.deliveryCount === 1) {
        throw boom;
      }
      m.ack();
      if (got.length === 3) {
        done.resolve();
      }
    }) as ConsumerCallbackFn,
  });
  await done;
  await iter.close();
  printed.restore();

  assertEquals(got, ["1:1", "2:1", "1:2"]);
  assertEquals(printed.errors.length, 1);
  assertEquals(
    printed.errors[0].message,
    'consumer "c" on stream "A" callback threw Error: boom',
  );
  assert(printed.errors[0].cause === boom);

  await cleanup(ns, nc);
});

Deno.test("callback errors - a rejecting consume callback is printed and the consumer continues", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  await stream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add("A", {
    durable_name: "c",
    ack_policy: AckPolicy.Explicit,
  });
  using printed = capturePrinted();

  const got: string[] = [];
  const js = jetstream(nc);
  const c = await js.consumers.get("A", "c");
  const iter = await c.consume({
    callback: (async (m: JsMsg) => {
      got.push(m.string());
      m.ack();
      await delay(0);
      throw undefined;
    }) as ConsumerCallbackFn,
  });
  await delay(500);
  await iter.close();
  printed.restore();

  assertEquals(got, ["1", "2"]);
  assertEquals(printed.errors.map((e) => e.message), [
    'consumer "c" on stream "A" callback threw undefined',
    'consumer "c" on stream "A" callback threw undefined',
  ]);

  await cleanup(ns, nc);
});

Deno.test("callback errors - a failing push consumer callback is printed and the consumer continues", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  await stream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add("A", {
    durable_name: "p",
    deliver_subject: "deliver.p",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });
  using printed = capturePrinted();

  const got: string[] = [];
  const done = deferred<void>();
  const js = jetstream(nc);
  const c = await js.consumers.getPushConsumer("A", "p");
  const iter = await c.consume({
    callback: (m) => {
      got.push(m.string());
      m.ack();
      if (got.length === 2) {
        done.resolve();
      }
      throw null;
    },
  });
  await done;
  await iter.close();
  printed.restore();

  assertEquals(got, ["1", "2"]);
  assertEquals(printed.errors.map((e) => e.message), [
    'consumer "p" on stream "A" callback threw null',
    'consumer "p" on stream "A" callback threw null',
  ]);

  await cleanup(ns, nc);
});

Deno.test("callback errors - a failing direct get callback is printed and the batch continues", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  await stream(nc);
  using printed = capturePrinted();

  const jsm = await jetstreamManager(nc);
  const calls: (Error | undefined | string)[] = [];
  const done = deferred<void>();
  await jsm.direct.getBatch("A", {
    seq: 1,
    callback: (d, m: StoredMsg) => {
      if (d) {
        calls.push(d.err);
        done.resolve();
        // failing on the done notification is printed too
        throw "again";
      }
      calls.push(m.string());
      throw undefined;
    },
  });
  await done;
  await delay(20);
  printed.restore();

  // every message and the end of the batch were delivered
  assertEquals(calls, ["1", "2", undefined]);
  const where = 'direct get on stream "A" callback threw';
  assertEquals(printed.errors.map((e) => e.message), [
    `${where} undefined`,
    `${where} undefined`,
    `${where} "again"`,
  ]);

  await cleanup(ns, nc);
});

Deno.test("callback errors - a callback consumer still stops with the error of a closed connection", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  await stream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add("A", {
    durable_name: "c",
    ack_policy: AckPolicy.Explicit,
  });

  // the library's own stop notifications aren't user callbacks, the consumer
  // stops on them as it always has
  const js = jetstream(nc);
  const c = await js.consumers.get("A", "c");
  const iter = await c.consume({
    callback: (m) => {
      m.ack();
    },
  });
  await nc.close();
  await deadline(iter.closed(), 2000);

  await ns.stop();
});
