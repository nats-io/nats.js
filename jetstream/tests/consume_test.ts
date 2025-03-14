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
import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertRejects,
} from "jsr:@std/assert";
import { initStream, setupStreamAndConsumer } from "./jstest_util.ts";
import {
  deadline,
  deferred,
  delay,
  errors,
  nanos,
  type NatsConnectionImpl,
  syncIterator,
} from "@nats-io/nats-core/internal";
import type { PullConsumerMessagesImpl } from "../src/consumer.ts";
import {
  AckPolicy,
  DeliverPolicy,
  isPullConsumer,
  isPushConsumer,
  jetstream,
  jetstreamManager,
} from "../src/mod.ts";
import type { PushConsumerMessagesImpl } from "../src/pushconsumer.ts";
import type { ConsumerNotification, HeartbeatsMissed } from "../src/types.ts";

Deno.test("consumers - consume", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const count = 1000;
  const { stream, consumer } = await setupStreamAndConsumer(nc, count);

  const js = jetstream(nc, { timeout: 30_000 });
  const c = await js.consumers.get(stream, consumer);
  assert(isPullConsumer(c));
  assertFalse(isPushConsumer(c));

  const ci = await c.info();
  assertEquals(ci.num_pending, count);
  const start = Date.now();
  const iter = await c.consume({ expires: 2_000, max_messages: 10 });
  for await (const m of iter) {
    m.ack();
    if (m.info.pending === 0) {
      const millis = Date.now() - start;
      console.log(
        `consumer: ${millis}ms - ${count / (millis / 1000)} msgs/sec`,
      );
      break;
    }
  }
  assertEquals(iter.getReceived(), count);
  assertEquals(iter.getProcessed(), count);
  assertEquals((await c.info()).num_pending, 0);
  await cleanup(ns, nc);
});

Deno.test("consumers - consume callback rejects iter", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream, consumer } = await setupStreamAndConsumer(nc, 0);
  const js = jetstream(nc);
  const c = await js.consumers.get(stream, consumer);
  const iter = await c.consume({
    expires: 5_000,
    max_messages: 10_000,
    callback: (m) => {
      m.ack();
    },
  });

  await assertRejects(
    async () => {
      for await (const _o of iter) {
        // should fail
      }
    },
    errors.InvalidOperationError,
    "iterator cannot be used when a callback is registered",
  );
  iter.stop();

  await cleanup(ns, nc);
});

Deno.test("consume - heartbeats", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "a",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const c = await js.consumers.get(stream, "a");
  const iter = await c.consume({
    max_messages: 100,
    idle_heartbeat: 1000,
    expires: 30000,
  }) as PushConsumerMessagesImpl;

  // make heartbeats trigger
  (nc as NatsConnectionImpl)._resub(iter.sub, "foo");

  const d = deferred<ConsumerNotification>();
  await (async () => {
    const status = iter.status();
    for await (const s of status) {
      d.resolve(s);
      iter.stop();
      break;
    }
  })();

  await (async () => {
    for await (const _r of iter) {
      // nothing
    }
  })();

  const cs = await d;
  assertEquals(cs.type, "heartbeats_missed");
  assertEquals((cs as HeartbeatsMissed).count, 2);

  await cleanup(ns, nc);
});

Deno.test("consume - deleted consumer", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "a",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const c = await js.consumers.get(stream, "a");
  const iter = await c.consume({
    expires: 3000,
  });

  const deleted = deferred();
  let notFound = 0;
  const done = deferred<number>();
  (async () => {
    const status = iter.status();
    for await (const s of status) {
      if (s.type === "consumer_deleted") {
        deleted.resolve();
      }
      if (s.type === "consumer_not_found") {
        notFound++;
        if (notFound > 1) {
          done.resolve();
        }
      }
    }
  })().then();

  (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })().then();

  setTimeout(() => {
    jsm.consumers.delete(stream, "a");
  }, 1000);

  await deleted;
  await done;
  await iter.close();

  await cleanup(ns, nc);
});

Deno.test("consume - sub leaks", async () => {
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
  const iter = await c.consume({ expires: 30000 });
  const done = (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })().then();
  setTimeout(() => {
    iter.close();
  }, 1000);

  await done;
  //@ts-ignore: test
  assertEquals(nc.protocol.subscriptions.size(), 1);
  await cleanup(ns, nc);
});

Deno.test("consume - drain", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream } = await initStream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: stream,
    ack_policy: AckPolicy.Explicit,
  });
  //@ts-ignore: test
  const js = jetstream(nc);
  const c = await js.consumers.get(stream, stream);
  const iter = await c.consume({ expires: 30000 });
  setTimeout(() => {
    nc.drain();
  }, 100);
  const done = (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })().then();

  await deadline(done, 1000);

  await cleanup(ns, nc);
});

Deno.test("consume - sync", async () => {
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
  const iter = await consumer.consume() as PullConsumerMessagesImpl;
  const sync = syncIterator(iter);
  assertExists(await sync.next());
  assertExists(await sync.next());
  iter.stop();
  assertEquals(await sync.next(), null);
  await cleanup(ns, nc);
});

Deno.test("consume - stream not found request abort", async () => {
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
  const iter = await c.consume({
    expires: 3000,
    abort_on_missing_resource: true,
  });
  await jsm.streams.delete("A");

  await assertRejects(
    async () => {
      for await (const _ of iter) {
        // nothing
      }
    },
    Error,
    "stream not found",
  );

  await cleanup(ns, nc);
});

Deno.test("consume - consumer deleted request abort", async () => {
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
  const iter = await c.consume({
    expires: 3000,
    abort_on_missing_resource: true,
  });

  const done = assertRejects(
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
  await done;

  await cleanup(ns, nc);
});

Deno.test("consume - consumer not found request abort", async () => {
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
  await c.delete();

  const iter = await c.consume({
    expires: 3000,
    abort_on_missing_resource: true,
  });

  await assertRejects(
    async () => {
      for await (const _ of iter) {
        // nothing
      }
    },
    Error,
    "consumer not found",
  );

  await cleanup(ns, nc);
});

Deno.test("consume - consumer bind", async () => {
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
  await c.delete();

  const cisub = nc.subscribe("$JS.API.CONSUMER.INFO.A.a", {
    callback: () => {},
  });

  const iter = await c.consume({
    expires: 1000,
    bind: true,
  });

  let hbm = 0;
  let cnf = 0;

  (async () => {
    for await (const s of iter.status()) {
      switch (s.type) {
        case "heartbeats_missed":
          hbm++;
          if (hbm > 5) {
            iter.stop();
          }
          break;
        case "consumer_not_found":
          cnf++;
          break;
      }
    }
  })().then();

  const done = (async () => {
    for await (const _ of iter) {
      // nothing
    }
  })();

  await done;
  assert(hbm > 1);
  assertEquals(cnf, 0);
  assertEquals(cisub.getProcessed(), 0);

  await cleanup(ns, nc);
});

Deno.test("consume - connection close exits", async () => {
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

  const iter = await c.consume({
    expires: 2000,
    max_messages: 10,
    callback: (m) => {
      m.ack();
    },
  }) as PullConsumerMessagesImpl;

  await nc.close();
  await deadline(iter.closed(), 1000);

  await cleanup(ns, nc);
});

Deno.test("consume - one pending is none", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  const js = jsm.jetstream();
  const buf = [];
  for (let i = 0; i < 100; i++) {
    buf.push(js.publish("a", `${i}`));
  }
  await Promise.all(buf);

  await jsm.consumers.add("A", {
    durable_name: "a",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });

  const c = await js.consumers.get("A", "a");
  const iter = await c.consume({ bind: true, max_messages: 1 });
  for await (const m of iter) {
    assertEquals(iter.getPending(), 0);
    assertEquals(iter.getReceived(), m.seq);
    m.ack();
    if (m.info.pending === 0) {
      break;
    }
  }

  await cleanup(ns, nc);
});

Deno.test("consume - stream not found and no responders", async () => {
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
  const iter = await c.consume({ expires: 5_000 });

  const hbmP = deferred();

  const buf: ConsumerNotification[] = [];
  (async () => {
    for await (const s of await iter.status()) {
      console.log(s);
      buf.push(s);
      if (s.type === "heartbeats_missed" && s.count === 3) {
        hbmP.resolve();
      }
    }
  })().then();

  const nextP = deferred();
  (async () => {
    for await (const _ of iter) {
      nextP.resolve();
    }
  })().then();

  await hbmP;
  const snfs = buf.filter((s) => s.type === "stream_not_found").length;
  const nrs = buf.filter((s) => s.type === "no_responders").length;

  assert(snfs > 0);
  assert(nrs > 0);

  await jsm.streams.add({ name: "messages", subjects: ["m"] });
  await jsm.jetstream().publish("m");
  await jsm.consumers.add("messages", {
    name: "c",
    deliver_policy: DeliverPolicy.All,
  });

  await nextP;

  await cleanup(ns, nc);
});

Deno.test("consume - consumer not found and no responders", async () => {
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
  const iter = await c.consume({ expires: 5_000 });

  const hbmP = deferred();

  const buf: ConsumerNotification[] = [];
  (async () => {
    for await (const s of await iter.status()) {
      console.log(s);
      buf.push(s);
      if (s.type === "heartbeats_missed" && s.count === 3) {
        hbmP.resolve();
      }
    }
  })().then();

  const nextP = deferred();
  (async () => {
    for await (const _ of iter) {
      nextP.resolve();
    }
  })().then();

  await hbmP;
  const snfs = buf.filter((s) => s.type === "consumer_not_found").length;
  const nrs = buf.filter((s) => s.type === "no_responders").length;

  assert(snfs > 0);
  assert(nrs > 0);

  await jsm.jetstream().publish("m");

  const ci = await jsm.consumers.add("messages", {
    name: "c",
    deliver_policy: DeliverPolicy.All,
  });
  console.log(ci);

  await nextP;

  await cleanup(ns, nc);
});
