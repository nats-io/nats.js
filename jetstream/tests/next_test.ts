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

import {
  _setup,
  cleanup,
  connect,
  flakyTest,
  jetstreamServerConf,
} from "test_helpers";
import { initStream } from "./jstest_util.ts";
import { AckPolicy, DeliverPolicy } from "../src/jsapi_types.ts";
import { assertEquals, assertRejects, fail } from "jsr:@std/assert";
import { delay, nanos } from "@nats-io/nats-core";
import type { NatsConnectionImpl } from "@nats-io/nats-core/internal";
import { jetstream, jetstreamManager } from "../src/mod.ts";
import { delayUntilAssetNotFound } from "./util.ts";
import {
  ConsumerNotFoundError,
  JetStreamStatusError,
  StreamNotFoundError,
} from "../src/jserrors.ts";

Deno.test("next - basics", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
      if (m.info?.redeliveryCount > 100) {
        break;
      }
    }
  }
  assertEquals(nci.protocol.listeners.length, base);

  await cleanup(ns, nc);
});

Deno.test(
  "next - consumer not found",
  flakyTest(async () => {
    const { ns, nc } = await _setup(connect, jetstreamServerConf());
    const jsm = await jetstreamManager(nc);
    await jsm.streams.add({ name: "A", subjects: ["hello"] });

    await jsm.consumers.add("A", {
      durable_name: "a",
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.Explicit,
    });

    const js = jetstream(nc);
    const c = await js.consumers.get("A", "a");
    await c.delete();
    await delay(1000);

    await assertRejects(
      () => {
        return c.next({ expires: 1000 });
      },
      ConsumerNotFoundError,
    );

    await cleanup(ns, nc);
  }),
);

Deno.test("next - deleted consumer", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());

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

Deno.test(
  "next - stream not found",
  async () => {
    const { ns, nc } = await _setup(connect, jetstreamServerConf());

    const jsm = await jetstreamManager(nc);
    await jsm.streams.add({ name: "A", subjects: ["hello"] });
    const s = await jsm.streams.get("A");

    await jsm.consumers.add("A", {
      durable_name: "a",
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.Explicit,
    });

    const js = jetstream(nc);

    const c = await js.consumers.get("A", "a");

    await jsm.streams.delete("A");
    await delayUntilAssetNotFound(s);

    await assertRejects(
      () => {
        return c.next({ expires: 1000 });
      },
      StreamNotFoundError,
    );

    await cleanup(ns, nc);
  },
);

Deno.test("next - consumer bind", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());

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
  await c.delete();

  // listen to see if the client does a consumer info
  const cisub = nc.subscribe("$JS.API.CONSUMER.INFO.A.a", {
    callback: () => {
      fail("saw a consumer info");
    },
  });

  const msg = await c.next({
    expires: 1000,
    bind: true,
  });

  await nc.flush();

  assertEquals(msg, null);
  assertEquals(cisub.getProcessed(), 0);

  await cleanup(ns, nc);
});
