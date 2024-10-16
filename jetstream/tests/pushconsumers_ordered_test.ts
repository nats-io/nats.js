/*
 * Copyright 2023-2024 The NATS Authors
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

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert";
import { DeliverPolicy, jetstream, jetstreamManager } from "../src/mod.ts";
import type { JsMsg } from "../src/mod.ts";

import {
  _setup,
  cleanup,
  connect,
  jetstreamServerConf,
  notCompatible,
} from "test_helpers";
import type {
  PushConsumerImpl,
  PushConsumerMessagesImpl,
} from "../src/pushconsumer.ts";
import { delay } from "@nats-io/nats-core/internal";
import type { NatsConnectionImpl } from "@nats-io/nats-core/internal";
import { flakyTest } from "../../test_helpers/mod.ts";

Deno.test("ordered push consumers - get", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const js = jetstream(nc);

  await assertRejects(
    () => {
      return js.consumers.getPushConsumer("a");
    },
    Error,
    "stream not found",
  );

  const jsm = await js.jetstreamManager();
  await jsm.streams.add({ name: "test", subjects: ["test"] });
  await js.publish("test");

  const oc = await js.consumers.getPushConsumer(
    "test",
  ) as PushConsumerImpl;

  assertExists(oc);
  const ci = await oc.info();
  assertEquals(ci.num_pending, 1);
  assertEquals(ci.name, `${oc.opts.name_prefix}_${oc.serial}`);

  await cleanup(ns, nc);
});

Deno.test(
  "ordered push consumers - consume reset",
  flakyTest(async () => {
    const { ns, nc } = await _setup(connect, jetstreamServerConf());
    const js = jetstream(nc);

    const jsm = await jetstreamManager(nc);
    await jsm.streams.add({ name: "test", subjects: ["test.*"] });
    await js.publish("test.a");
    await js.publish("test.b");
    await js.publish("test.c");

    const oc = await js.consumers.getPushConsumer(
      "test",
    ) as PushConsumerImpl;
    assertExists(oc);

    const seen: number[] = new Array(3).fill(0);

    const iter = await oc.consume({
      callback: (m: JsMsg) => {
        const idx = m.seq - 1;
        seen[idx]++;
        // mess with the internals so we see these again
        if (seen[idx] === 1) {
          iter.cursor.deliver_seq--;
          iter.cursor.stream_seq--;
        }
        if (m.info.pending === 0) {
          iter.stop();
        }
      },
    }) as PushConsumerMessagesImpl;
    await iter.closed();

    assertEquals(seen, [2, 2, 1]);
    assertEquals(oc.serial, 3);

    await cleanup(ns, nc);
  }),
);

Deno.test("ordered push consumers - consume", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const js = jetstream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });
  await js.publish("test.a");
  await js.publish("test.b");
  await js.publish("test.c");

  const oc = await js.consumers.getPushConsumer("test");
  assertExists(oc);

  const iter = await oc.consume();
  for await (const m of iter) {
    if (m.info.pending === 0) {
      break;
    }
  }

  assertEquals(iter.getProcessed(), 3);

  await cleanup(ns, nc);
});

Deno.test("ordered push consumers - filters consume", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await js.publish("test.a");
  await js.publish("test.b");
  await js.publish("test.c");

  const oc = await js.consumers.getPushConsumer("test", {
    filter_subjects: ["test.b"],
  });
  assertExists(oc);

  const iter = await oc.consume();
  for await (const m of iter) {
    assertEquals("test.b", m.subject);
    if (m.info.pending === 0) {
      break;
    }
  }

  await iter.closed();
  assertEquals(iter.getProcessed(), 1);

  await cleanup(ns, nc);
});

Deno.test("ordered push consumers - last per subject", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await Promise.all([
    js.publish("test.a"),
    js.publish("test.a"),
  ]);

  const oc = await js.consumers.getPushConsumer("test", {
    deliver_policy: DeliverPolicy.LastPerSubject,
  });

  const iter = await oc.consume();
  await (async () => {
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 2);
      break;
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("ordered push consumers - start sequence", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await Promise.all([
    js.publish("test.a"),
    js.publish("test.b"),
  ]);

  const oc = await js.consumers.getPushConsumer("test", {
    opt_start_seq: 2,
  });

  const iter = await oc.consume();
  await (async () => {
    for await (const r of iter) {
      assertEquals(r.info.streamSequence, 2);
      assertEquals(r.subject, "test.b");
      break;
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("ordered push consumers - sub leak", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });
  const js = jetstream(nc);
  await Promise.all([
    js.publish("test.a"),
    js.publish("test.b"),
  ]);

  const oc = await js.consumers.getPushConsumer("test");
  const iter = await oc.consume() as PushConsumerMessagesImpl;
  await (async () => {
    for await (const r of iter) {
      if (r.info.streamSequence === 2) {
        break;
      }
    }
  })();

  await delay(1000);

  const nci = nc as NatsConnectionImpl;
  nci.protocol.subscriptions.subs.forEach((s) => {
    console.log(">", s.subject);
  });

  await cleanup(ns, nc);
});
