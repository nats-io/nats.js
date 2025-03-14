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
import { AckPolicy, DeliverPolicy } from "../src/jsapi_types.ts";
import {
  assertEquals,
  assertExists,
  assertRejects,
  fail,
} from "jsr:@std/assert";
import { delay, nanos } from "@nats-io/nats-core";
import type { NatsConnectionImpl } from "@nats-io/nats-core/internal";
import { jetstream, JetStreamError, jetstreamManager } from "../src/mod.ts";
import { JetStreamStatusError } from "../src/jserrors.ts";

Deno.test("next - basics", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream, subj } = await initStream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: stream,
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const c = await js.consumers.get(stream, stream);
  let ci = await c.info(true);
  assertEquals(ci.num_pending, 0);

  let m = await c.next({ expires: 1000 });
  assertEquals(m, null);

  await Promise.all([js.publish(subj), js.publish(subj)]);
  ci = await c.info();
  assertEquals(ci.num_pending, 2);

  m = await c.next();
  assertEquals(m?.seq, 1);
  m?.ack();
  await nc.flush();

  ci = await c.info();
  assertEquals(ci?.num_pending, 1);
  m = await c.next();
  assertEquals(m?.seq, 2);
  m?.ack();

  await cleanup(ns, nc);
});

Deno.test("next - sub leaks", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream } = await initStream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: stream,
    ack_policy: AckPolicy.Explicit,
  });
  //@ts-ignore: test
  assertEquals(nc.protocol.subscriptions.size(), 1);
  const js = jetstream(nc);
  const c = await js.consumers.get(stream, stream);
  await c.next({ expires: 1000 });
  //@ts-ignore: test
  assertEquals(nc.protocol.subscriptions.size(), 1);
  await cleanup(ns, nc);
});

Deno.test("next - listener leaks", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "messages", subjects: ["hello"] });

  const js = jetstream(nc);
  await js.publish("hello");

  await jsm.consumers.add("messages", {
    durable_name: "myconsumer",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(3000),
    max_waiting: 500,
  });

  const nci = nc as NatsConnectionImpl;
  const base = nci.protocol.listeners.length;

  const consumer = await js.consumers.get("messages", "myconsumer");

  while (true) {
    const m = await consumer.next();
    if (m) {
      m.nak();
      if (m.info?.deliveryCount > 100) {
        break;
      }
    }
  }
  assertEquals(nci.protocol.listeners.length, base);

  await cleanup(ns, nc);
});

Deno.test("next - deleted consumer", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["hello"] });

  await jsm.consumers.add("A", {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const c = await js.consumers.get("A", "a");

  const exited = assertRejects(
    () => {
      return c.next({ expires: 4000 });
    },
    JetStreamStatusError,
    "consumer deleted",
  );
  await delay(1000);
  await c.delete();

  await exited;

  await cleanup(ns, nc);
});

Deno.test("next - consumer bind", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  await jsm.consumers.add("A", {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.None,
  });

  const js = jetstream(nc);
  await js.publish("a");

  const c = await js.consumers.get("A", "a");

  // listen to see if the client does a consumer info
  const sub = nc.subscribe("$JS.API.CONSUMER.INFO.A.a", {
    callback: () => {
      fail("saw a consumer info");
    },
  });

  let msg = await c.next({
    expires: 1000,
    bind: true,
  });
  assertExists(msg);

  msg = await c.next({
    expires: 1000,
    bind: true,
  });
  assertEquals(msg, null);

  await c.delete();

  await assertRejects(
    () => {
      return c.next({
        expires: 1000,
        bind: true,
      });
    },
    JetStreamError,
    "no responders",
  );

  await nc.flush();

  assertEquals(msg, null);
  assertEquals(sub.getProcessed(), 0);

  await cleanup(ns, nc);
});

Deno.test("next - delivery count", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["hello"] });

  await jsm.consumers.add("A", {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    max_deliver: 2,
    ack_wait: nanos(1000),
  });

  const js = jetstream(nc);
  await js.publish("hello");

  const c = await js.consumers.get("A", "a");
  let m = await c.next();
  assertEquals(m?.info.deliveryCount, 1);
  await delay(1500);
  m = await c.next();
  await delay(1500);
  assertEquals(m?.info.deliveryCount, 2);
  m = await c.next({ expires: 1000 });
  assertEquals(m, null);

  await cleanup(ns, nc);
});

Deno.test("next - connection close exits", async () => {
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

  assertRejects(
    () => {
      return c.next({ expires: 30_000 });
    },
    Error,
    "closed connection",
  );

  await nc.close();

  await cleanup(ns, nc);
});

Deno.test("next - stream not found and no responders", async () => {
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
    () => {
      return c.next({ expires: 5_000 });
    },
    Error,
    "no responder",
  );

  await jsm.streams.add({ name: "messages", subjects: ["m"] });
  await jsm.consumers.add("messages", {
    name: "c",
    deliver_policy: DeliverPolicy.All,
  });
  await jsm.jetstream().publish("m");

  const m = await c.next();
  assertExists(m);

  await cleanup(ns, nc);
});

Deno.test("next - consumer not found and no responders", async () => {
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
    () => {
      return c.next({ expires: 5_000 });
    },
    Error,
    "no responders",
  );

  await jsm.consumers.add("messages", {
    name: "c",
    deliver_policy: DeliverPolicy.All,
  });
  await jsm.jetstream().publish("m");

  const m = await c.next();
  assertExists(m);

  await cleanup(ns, nc);
});
