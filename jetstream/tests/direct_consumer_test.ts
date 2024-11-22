/*
 * Copyright 2024 Synadia Communications, Inc
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
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertIsError,
  assertRejects,
  fail,
} from "jsr:@std/assert";

import { deferred, delay } from "@nats-io/nats-core";

import {
  jetstream,
  JetStreamError,
  jetstreamManager,
  StorageType,
  type StoredMsg,
} from "../src/mod.ts";
import {
  cleanup,
  jetstreamServerConf,
  notCompatible,
  notSupported,
  setup,
} from "test_helpers";
import { DirectConsumer, DirectStreamAPIImpl } from "../src/jsm_direct.ts";

Deno.test("direct consumer - next", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"], allow_direct: true });

  const js = jsm.jetstream();
  await Promise.all([
    js.publish("a"),
    js.publish("a"),
    js.publish("a"),
  ]);

  const dc = new DirectConsumer("A", new DirectStreamAPIImpl(nc));

  const m = await dc.next();
  console.log(m);
  assertEquals(m?.seq, 1);
  assertEquals((await dc.next())?.seq, 2);
  assertEquals((await dc.next())?.seq, 3);
  assertEquals(await dc.next(), null);

  await cleanup(ns, nc);
});

Deno.test("direct consumer - batch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"], allow_direct: true });

  const js = jsm.jetstream();
  const buf = [];
  for (let i = 0; i < 100; i++) {
    buf.push(js.publish("a", `${i}`));
  }

  await Promise.all(buf);

  const dc = new DirectConsumer("A", new DirectStreamAPIImpl(nc));

  let iter = await dc.fetch({ max_messages: 5 });
  let s = 0;
  for await (const sm of iter) {
    console.log(sm);
    assertEquals(sm.seq, ++s);
  }
  assertEquals(s, 5);
  const m = await dc.next();
  assertEquals(m?.seq, 6);
  s = 6;

  iter = await dc.fetch();
  for await (const sm of iter) {
    assertEquals(sm.seq, ++s);
  }
  assertEquals(s, 100);

  await cleanup(ns, nc);
});
