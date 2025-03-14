/*
 * Copyright 2022-2024 The NATS Authors
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

import { cleanup, jetstreamServerConf, setup } from "test_helpers";
import { initStream } from "./jstest_util.ts";
import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert";
import {
  deadline,
  deferred,
  delay,
  Empty,
  nanos,
  syncIterator,
} from "@nats-io/nats-core";
import type { NatsConnectionImpl } from "@nats-io/nats-core/internal";
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
} from "../src/mod.ts";
import type { PullConsumerMessagesImpl } from "../src/consumer.ts";

Deno.test("fetch - no messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "b",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const consumer = await js.consumers.get(stream, "b");
  const iter = await consumer.fetch({
    max_messages: 100,
    expires: 1000,
  });
  for await (const m of iter) {
    m.ack();
  }
  assertEquals(iter.getReceived(), 0);
  assertEquals(iter.getProcessed(), 0);

  await cleanup(ns, nc);
});

Deno.test("fetch - less messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const { stream, subj } = await initStream(nc);
  const js = jetstream(nc);
  await js.publish(subj, Empty);

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "b",
    ack_policy: AckPolicy.Explicit,
  });

  const consumer = await js.consumers.get(stream, "b");
  assertEquals((await consumer.info(true)).num_pending, 1);
  const iter = await consumer.fetch({ expires: 1000, max_messages: 10 });
  for await (const m of iter) {
    m.ack();
  }
  assertEquals(iter.getReceived(), 1);
  assertEquals(iter.getProcessed(), 1);

  await cleanup(ns, nc);
});

Deno.test("fetch - exactly messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const { stream, subj } = await initStream(nc);
  const js = jetstream(nc);
  await Promise.all(
    new Array(200).fill("a").map((_, idx) => {
      return js.publish(subj, `${idx}`);
    }),
  );

  const jsm = await jetstreamManager(nc);

  await jsm.consumers.add(stream, {
    durable_name: "b",
    ack_policy: AckPolicy.Explicit,
  });

  const consumer = await js.consumers.get(stream, "b");
  assertEquals((await consumer.info(true)).num_pending, 200);

  const iter = await consumer.fetch({ expires: 5000, max_messages: 100 });
  for await (const m of iter) {
    m.ack();
  }
  assertEquals(iter.getReceived(), 100);
  assertEquals(iter.getProcessed(), 100);

  await cleanup(ns, nc);
});

Deno.test("fetch - deleted consumer", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  await jsm.consumers.add("A", {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const c = await js.consumers.get("A", "a");

  const iter = await c.fetch({
    expires: 3000,
  });

  const exited = assertRejects(
    async () => {
      for await (const _ of iter) {
        // nothing
      }
    },
    Error,
    "consumer deleted",
  );

  await delay(1000);
  await c.delete();

  await exited;
  await cleanup(ns, nc);
});

Deno.test("fetch - listener leaks", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "messages", subjects: ["hello"] });

  const js = jetstream(nc);

  await jsm.consumers.add("messages", {
    durable_name: "myconsumer",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });

  const nci = nc as NatsConnectionImpl;
  const base = nci.protocol.listeners.length;

  const consumer = await js.consumers.get("messages", "myconsumer");
  const iter = await consumer.fetch({ max_messages: 1, expires: 2000 });
  for await (const _ of iter) {
    // nothing
  }

  assertEquals(nci.protocol.listeners.length, base);
  await cleanup(ns, nc);
});

Deno.test("fetch - sync", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "messages", subjects: ["hello"] });

  const js = jetstream(nc);
  await js.publish("hello");
  await js.publish("hello");

  await jsm.consumers.add("messages", {
    durable_name: "c",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(3000),
    max_waiting: 500,
  });

  const consumer = await js.consumers.get("messages", "c");
  const iter = await consumer.fetch({ max_messages: 2 });
  const sync = syncIterator(iter);
  assertExists(await sync.next());
  assertExists(await sync.next());
  assertEquals(await sync.next(), null);
  await cleanup(ns, nc);
});

Deno.test("fetch - consumer bind", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  await jsm.consumers.add("A", {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  await js.publish("a");

  const c = await js.consumers.get("A", "a");

  const cisub = nc.subscribe("$JS.API.CONSUMER.INFO.A.a", {
    callback: () => {},
  });

  let iter = await c.fetch({
    expires: 1000,
    bind: true,
  });

  for await (const _ of iter) {
    // nothing
  }

  iter = await c.fetch({
    expires: 1000,
    bind: true,
  });

  for await (const _ of iter) {
    // nothing
  }

  assertEquals(cisub.getProcessed(), 0);
  await cleanup(ns, nc);
});

Deno.test("fetch - exceeding max_messages will stop", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });
  await jsm.consumers.add("A", {
    durable_name: "a",
    max_batch: 100,
  });

  const js = jetstream(nc);
  const c = await js.consumers.get("A", "a");
  const iter = await c.fetch({ max_messages: 1000 });
  await assertRejects(
    async () => {
      for await (const _ of iter) {
        // ignore
      }
    },
    Error,
    "exceeded maxrequestbatch of 100",
  );

  await cleanup(ns, nc);
});

Deno.test("fetch - timer is based on idle_hb", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  await jsm.consumers.add("A", {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  await js.publish("a");
  const c = await js.consumers.get("A", "a");

  const iter = await c.fetch({
    expires: 2000,
    max_messages: 10,
  }) as PullConsumerMessagesImpl;

  let hbm = false;
  (async () => {
    for await (const s of iter.status()) {
      console.log(s);
      if (s.type === "heartbeats_missed") {
        hbm = true;
      }
    }
  })().then();

  const buf = [];
  await assertRejects(
    async () => {
      for await (const m of iter) {
        buf.push(m);
        m.ack();
        // make the subscription now fail
        const nci = nc as NatsConnectionImpl;
        nci._resub(iter.sub, "foo");
      }
    },
    Error,
    "heartbeats missed",
  );

  assertEquals(buf.length, 1);
  assertEquals(hbm, true);

  await cleanup(ns, nc);
});

Deno.test("fetch - connection close exits", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  await jsm.consumers.add("A", {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  await js.publish("a");
  const c = await js.consumers.get("A", "a");

  const iter = await c.fetch({
    expires: 30_000,
    max_messages: 10,
  }) as PullConsumerMessagesImpl;

  const done = (async () => {
    for await (const _ of iter) {
      // nothing
    }
  })();

  await nc.close();
  await deadline(done, 1000);

  await cleanup(ns, nc);
});

Deno.test("fetch - stream not found and no responders", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf(),
  );

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "messages", subjects: ["m"] });
  await jsm.consumers.add("messages", {
    name: "c",
    deliver_policy: DeliverPolicy.All,
  });

  const c = await jsm.jetstream().consumers.get("messages", "c");
  await jsm.streams.delete("messages");
  await assertRejects(
    async () => {
      const iter = await c.fetch({ expires: 5_000 });
      for await (const _ of iter) {
        // ignored
      }
    },
    Error,
    "no responders",
  );

  await jsm.streams.add({ name: "messages", subjects: ["m"] });
  await jsm.consumers.add("messages", {
    name: "c",
    deliver_policy: DeliverPolicy.All,
  });
  await jsm.jetstream().publish("m");

  const mP = deferred();
  const iter = await c.fetch({ expires: 5_000 });
  for await (const _ of iter) {
    mP.resolve();
    break;
  }

  await mP;

  await cleanup(ns, nc);
});

Deno.test("fetch - consumer not found and no responders", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf(),
  );

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "messages", subjects: ["m"] });
  await jsm.consumers.add("messages", {
    name: "c",
    deliver_policy: DeliverPolicy.All,
  });

  const c = await jsm.jetstream().consumers.get("messages", "c");
  await jsm.consumers.delete("messages", "c");
  await assertRejects(
    async () => {
      const iter = await c.fetch({ expires: 5_000 });
      for await (const _ of iter) {
        // ignored
      }
    },
    Error,
    "no responders",
  );

  await jsm.consumers.add("messages", {
    name: "c",
    deliver_policy: DeliverPolicy.All,
  });
  await jsm.jetstream().publish("m");

  const mP = deferred();
  const iter = await c.fetch({ expires: 5_000 });
  for await (const _ of iter) {
    mP.resolve();
    break;
  }

  await mP;

  await cleanup(ns, nc);
});
