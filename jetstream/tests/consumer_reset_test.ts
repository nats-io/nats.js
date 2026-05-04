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
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
} from "../src/mod.ts";
import { Feature, type NatsConnectionImpl } from "@nats-io/nats-core/internal";
import { fill } from "./jstest_util.ts";

Deno.test("consumer reset - basic (no seq)", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "s", subjects: ["s.*"] });
  await jsm.consumers.add("s", {
    durable_name: "c",
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
  });

  await fill(nc, "s", 5);
  const js = jetstream(nc);

  const c = await js.consumers.get("s", "c");
  const iter = await c.fetch({ max_messages: 3, expires: 1000 });
  for await (const m of iter) {
    m.ack();
  }

  const s = await js.streams.get("s");
  const r = await s.resetConsumer("c");
  assertEquals(r.name, "c");
  assertEquals(r.stream_name, "s");
  assert(typeof r.reset_seq === "number");
  assertEquals(r.delivered.consumer_seq, 0);
  assertEquals(r.num_redelivered, 0);

  await cleanup(ns, nc);
});

Deno.test("consumer reset - with seq", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "s", subjects: ["s.*"] });
  await jsm.consumers.add("s", {
    durable_name: "c",
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
  });

  await fill(nc, "s", 5);
  const js = jetstream(nc);

  const stream = await js.streams.get("s");
  const r = await stream.resetConsumer("c", 3);
  assertEquals(r.reset_seq, 3);

  // next delivered message should be stream seq >= 3
  const c = await js.consumers.get("s", "c");
  const iter = await c.fetch({ max_messages: 1, expires: 1000 });
  for await (const m of iter) {
    assert(m.seq >= 3, `expected seq >= 3, got ${m.seq}`);
    m.ack();
  }

  await cleanup(ns, nc);
});

Deno.test("consumer reset - invalid seq", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "s", subjects: ["s.*"] });
  await jsm.consumers.add("s", {
    durable_name: "c",
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
  });

  const js = jetstream(nc);
  const stream = await js.streams.get("s");

  await assertRejects(
    () => stream.resetConsumer("c", -1),
    Error,
    "non-negative integer",
  );
  await assertRejects(
    () => stream.resetConsumer("c", 1.5),
    Error,
    "non-negative integer",
  );

  await cleanup(ns, nc);
});

Deno.test("consumer reset - version gate", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const nci = nc as NatsConnectionImpl;
  nci.features.disable(Feature.JS_CONSUMER_RESET);

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "s", subjects: ["s.*"] });
  await jsm.consumers.add("s", {
    durable_name: "c",
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
  });

  const js = jetstream(nc);
  const stream = await js.streams.get("s");

  await assertRejects(
    () => stream.resetConsumer("c"),
    Error,
    "consumer reset requires server",
  );

  await cleanup(ns, nc);
});

Deno.test("consumer reset - by_start_sequence allowed at/above", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "s", subjects: ["s.*"] });
  await jsm.consumers.add("s", {
    durable_name: "c",
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.StartSequence,
    opt_start_seq: 3,
  });

  await fill(nc, "s", 5);
  const js = jetstream(nc);
  const stream = await js.streams.get("s");

  // at the boundary: equals opt_start_seq is allowed
  const r = await stream.resetConsumer("c", 3);
  assertEquals(r.reset_seq, 3);

  // above the boundary is allowed
  const r2 = await stream.resetConsumer("c", 4);
  assertEquals(r2.reset_seq, 4);

  await cleanup(ns, nc);
});

Deno.test("consumer reset - by_start_sequence rejects below", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "s", subjects: ["s.*"] });
  await jsm.consumers.add("s", {
    durable_name: "c",
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.StartSequence,
    opt_start_seq: 5,
  });

  await fill(nc, "s", 10);
  const js = jetstream(nc);
  const stream = await js.streams.get("s");

  await assertRejects(
    () => stream.resetConsumer("c", 2),
    Error,
    "below start seq",
  );

  await cleanup(ns, nc);
});

Deno.test("consumer reset - rejects last policy server-side", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "s", subjects: ["s.*"] });
  await jsm.consumers.add("s", {
    durable_name: "c",
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.Last,
  });

  const js = jetstream(nc);
  const stream = await js.streams.get("s");

  // server should reject reset with seq for non-allowed policies
  await assertRejects(
    () => stream.resetConsumer("c", 1),
    Error,
  );

  await cleanup(ns, nc);
});
