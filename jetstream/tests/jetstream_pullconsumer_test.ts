/*
 * Copyright 2021-2023 The NATS Authors
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
  cleanup,
  connect,
  jetstreamExportServerConf,
  jetstreamServerConf,
  notCompatible,
  setup,
} from "test_helpers";
import { initStream } from "./jstest_util.ts";
import {
  AckPolicy,
  type ConsumerConfig,
  DeliverPolicy,
  type OverflowMinPendingAndMinAck,
  PriorityPolicy,
} from "../src/jsapi_types.ts";
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  deferred,
  delay,
  Empty,
  type Msg,
  nanos,
  nuid,
} from "@nats-io/nats-core";
import {
  type ConsumeOptions,
  type ConsumerMessages,
  jetstream,
  jetstreamManager,
} from "../src/mod.ts";

Deno.test("jetstream - pull consumer options", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  const v = await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    max_batch: 10,
    max_expires: nanos(20000),
  });

  assertEquals(v.config.max_batch, 10);
  assertEquals(v.config.max_expires, nanos(20000));

  await cleanup(ns, nc);
});

Deno.test("jetstream - cross account pull", async () => {
  const { ns, nc: admin } = await setup(jetstreamExportServerConf(), {
    user: "js",
    pass: "js",
  });

  // add a stream
  const { stream, subj } = await initStream(admin);
  const admjs = jetstream(admin);
  await admjs.publish(subj);
  await admjs.publish(subj);

  const admjsm = await jetstreamManager(admin);

  // create a durable config
  await admjsm.consumers.add(stream, {
    ack_policy: AckPolicy.None,
    durable_name: "me",
  });

  const nc = await connect({
    port: ns.port,
    user: "a",
    pass: "s3cret",
    inboxPrefix: "A",
  });

  // the api prefix is not used for pull/fetch()
  const js = jetstream(nc, { apiPrefix: "IPA" });
  const c = await js.consumers.get(stream, "me");
  let msg = await c.next();
  assertExists(msg);
  assertEquals(msg.seq, 1);
  msg = await c.next();
  assertExists(msg);
  assertEquals(msg.seq, 2);

  msg = await c.next({ expires: 5000 });
  assertEquals(msg, null);

  await cleanup(ns, admin, nc);
});

Deno.test("jetstream - last of", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const n = nuid.next();
  await jsm.streams.add({
    name: n,
    subjects: [`${n}.>`],
  });

  const subja = `${n}.A`;
  const subjb = `${n}.B`;

  const js = jetstream(nc);

  await js.publish(subja, Empty);
  await js.publish(subjb, Empty);
  await js.publish(subjb, Empty);
  await js.publish(subja, Empty);

  const opts = {
    durable_name: "B",
    filter_subject: subjb,
    deliver_policy: DeliverPolicy.Last,
    ack_policy: AckPolicy.Explicit,
  } as Partial<ConsumerConfig>;

  await jsm.consumers.add(n, opts);
  const c = await js.consumers.get(n, "B");
  const m = await c.next();
  assertExists(m);
  assertEquals(m.seq, 3);

  await cleanup(ns, nc);
});

Deno.test("jetstream - priority group", async (t) => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "A",
    subjects: [`a`],
  });

  const js = jetstream(nc);

  const buf = [];
  for (let i = 0; i < 100; i++) {
    buf.push(js.publish("a", Empty));
  }

  await Promise.all(buf);

  const opts = {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    priority_groups: ["overflow"],
    priority_policy: PriorityPolicy.Overflow,
  };

  await jsm.consumers.add("A", opts);

  function spyPull(): Promise<Msg> {
    const d = deferred<Msg>();
    nc.subscribe(`$JS.API.CONSUMER.MSG.NEXT.A.a`, {
      callback: (err, msg) => {
        if (err) {
          d.reject(err);
        }
        d.resolve(msg);
      },
    });

    return d;
  }

  await t.step("consume", async () => {
    async function check(opts: ConsumeOptions): Promise<void> {
      const c = await js.consumers.get("A", "a");

      const d = spyPull();
      const c1 = await c.consume(opts);
      const done = (async () => {
        for await (const m of c1) {
          m.ack();
        }
      })();

      const m = await d;
      c1.stop();
      await done;

      const po = m.json<OverflowMinPendingAndMinAck>();
      const oopts = opts as OverflowMinPendingAndMinAck;
      assertEquals(po.group, opts.group);
      assertEquals(po.min_ack_pending, oopts.min_ack_pending);
      assertEquals(po.min_pending, oopts.min_pending);
    }

    await check({
      max_messages: 2,
      group: "overflow",
      min_ack_pending: 2,
    });

    await check({
      max_messages: 2,
      group: "overflow",
      min_pending: 10,
    });

    await check({
      max_messages: 2,
      group: "overflow",
      min_pending: 10,
      min_ack_pending: 100,
    });
  });

  await t.step("fetch", async () => {
    async function check(opts: ConsumeOptions): Promise<void> {
      const c = await js.consumers.get("A", "a");

      const d = spyPull();
      const iter = await c.fetch(opts);
      for await (const m of iter) {
        m.ack();
      }

      const m = await d;
      const po = m.json<OverflowMinPendingAndMinAck>();
      const oopts = opts as OverflowMinPendingAndMinAck;
      assertEquals(po.group, opts.group);
      assertEquals(po.min_ack_pending, oopts.min_ack_pending);
      assertEquals(po.min_pending, oopts.min_pending);
    }

    await check({
      max_messages: 2,
      group: "overflow",
      min_ack_pending: 2,
      expires: 1000,
    });

    await check({
      max_messages: 2,
      group: "overflow",
      min_pending: 10,
      expires: 1000,
    });

    await check({
      max_messages: 2,
      group: "overflow",
      min_pending: 10,
      min_ack_pending: 100,
      expires: 1000,
    });
  });

  await t.step("next", async () => {
    async function check(opts: ConsumeOptions): Promise<void> {
      const c = await js.consumers.get("A", "a");
      const d = spyPull();
      await c.next(opts);

      const m = await d;
      const po = m.json<OverflowMinPendingAndMinAck>();
      const oopts = opts as OverflowMinPendingAndMinAck;
      assertEquals(po.group, opts.group);
      assertEquals(po.min_ack_pending, oopts.min_ack_pending);
      assertEquals(po.min_pending, oopts.min_pending);
    }

    await check({
      max_messages: 2,
      group: "overflow",
      min_ack_pending: 2,
      expires: 1000,
    });

    await check({
      max_messages: 2,
      group: "overflow",
      min_pending: 10,
      expires: 1000,
    });

    await check({
      max_messages: 2,
      group: "overflow",
      min_pending: 10,
      min_ack_pending: 100,
      expires: 1000,
    });
  });

  await cleanup(ns, nc);
});

Deno.test("jetstream - pinned client", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "A",
    subjects: [`a`],
  });

  const js = jetstream(nc);

  const buf = [];
  for (let i = 0; i < 100; i++) {
    buf.push(js.publish("a", Empty));
  }
  await Promise.all(buf);

  const opts = {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    priority_groups: ["pinned"],
    priority_timeout: nanos(5_000),
    priority_policy: PriorityPolicy.PinnedClient,
  };

  await jsm.consumers.add("A", opts);

  async function processStatus(
    msgs: ConsumerMessages,
    bailOn = "",
  ): Promise<string[]> {
    const buf = [];
    for await (const s of msgs.status()) {
      //@ts-ignore: test
      buf.push(s.type);
      if (bailOn === s.type) {
        msgs.stop();
      }
    }
    return buf;
  }

  async function process(msgs: ConsumerMessages, wait = 0) {
    for await (const m of msgs) {
      if (wait > 0) {
        await delay(wait);
      }
      m.ack();
      if (m.info.pending === 0) {
        break;
      }
    }
  }

  const a = await js.consumers.get("A", "a");
  const iter = await a.consume({ group: "pinned", max_messages: 1 });
  const eventsA = processStatus(iter, "consumer_unpinned").catch();
  const done = process(iter, 10_000);

  const b = await js.consumers.get("A", "a");
  const iter2 = await b.consume({ group: "pinned", max_messages: 1 });
  const eventsB = processStatus(iter2).catch();
  await process(iter2);
  await done;

  assertEquals(iter.getReceived(), 1);
  assertEquals(iter2.getReceived(), 99);

  // check that A was unpinned
  assertEquals(
    (await eventsA).filter((e) => {
      return e === "consumer_unpinned";
    }).length,
    1,
  );

  // and B was pinned
  assertEquals(
    (await eventsB).filter((e) => {
      return e === "consumer_pinned";
    }).length,
    1,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - unpin client", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "A",
    subjects: [`a`],
  });

  const js = jetstream(nc);
  for (let i = 0; i < 100; i++) {
    await js.publish("a", Empty);
  }

  const opts = {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    priority_groups: ["pinned"],
    priority_timeout: nanos(10_000),
    priority_policy: PriorityPolicy.PinnedClient,
  };

  await jsm.consumers.add("A", opts);

  async function bailOn(
    n: string,
    msgs: ConsumerMessages,
    bailOn = "",
  ): Promise<void> {
    for await (const s of msgs.status()) {
      // @ts-ignore: teest
      console.log(n, s.type === "next" ? s.type + "=" + s.options?.id : s.type);
      if (bailOn === s.type) {
        console.log(n, "bailing");
        msgs.stop();
      }
    }
  }

  async function process(n: string, msgs: ConsumerMessages) {
    for await (const m of msgs) {
      console.log(n, m.seq);
      m.ack();
      await delay(3_000);
    }
  }

  const a = await js.consumers.get("A", "a");
  const iter = await a.consume({
    group: "pinned",
    max_messages: 1,
    expires: 5000,
  });
  bailOn("a", iter, "consumer_unpinned").catch();
  const done = process("a", iter);

  const b = await js.consumers.get("A", "a");
  const iter2 = await b.consume({
    group: "pinned",
    max_messages: 1,
    expires: 5000,
  });
  bailOn("b", iter2, "consumer_pinned").catch();
  process("b", iter2).then();

  (async () => {
    for await (const a of jsm.advisories()) {
      console.log("advisory:", a.kind);
    }
  })().then();

  await jsm.consumers.unpin("A", "a", "pinned");
  await done;
  await js.publish("a", Empty);

  await iter.closed();
  assertEquals(iter.getReceived(), 1);
  await iter2.closed();
  assertEquals(iter2.getReceived(), 1);

  await cleanup(ns, nc);
});
