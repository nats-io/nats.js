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
import { assert, assertEquals } from "@std/assert";

import { jetstreamManager, type StoredMsg } from "../src/mod.ts";
import {
  cleanup,
  jetstreamServerConf,
  notCompatible,
  setup,
} from "test_helpers";
import {
  DirectConsumer,
  type DirectStartOptions,
  DirectStreamAPIImpl,
} from "../src/jsm_direct.ts";

Deno.test("direct consumer - next", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.12.0")) {
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

  const dc = new DirectConsumer(
    "A",
    new DirectStreamAPIImpl(nc),
    { seq: 0 } as DirectStartOptions,
  );

  const m = await dc.next();
  assertEquals(m?.seq, 1);
  assertEquals((await dc.next())?.seq, 2);
  assertEquals((await dc.next())?.seq, 3);
  assertEquals(await dc.next(), null);

  await cleanup(ns, nc);
});

Deno.test("direct consumer - batch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.12.0")) {
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

  const dc = new DirectConsumer(
    "A",
    new DirectStreamAPIImpl(nc),
    { seq: 0 } as DirectStartOptions,
  );

  let iter = await dc.fetch({ batch: 5 });
  let s = 0;
  let last: StoredMsg | undefined;
  for await (const sm of iter) {
    assertEquals(sm.seq, ++s);
    last = sm;
  }
  assertEquals(s, 5);
  assertEquals(last?.pending, 95);

  const n = await dc.next();
  if (n) {
    last = n;
    s = 6;
  }
  assertEquals(last?.seq, 6);

  iter = await dc.fetch();
  for await (const sm of iter) {
    last = sm;
    assertEquals(sm.seq, ++s);
  }
  assertEquals(s, 100);
  assertEquals(last?.pending, 0);

  await cleanup(ns, nc);
});

Deno.test("direct consumer - consume", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.12.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "A",
    subjects: ["a", "b"],
    allow_direct: true,
  });

  const js = jsm.jetstream();
  const buf = [];
  for (let i = 0; i < 100; i++) {
    const subj = Math.random() >= .5 ? "b" : "a";
    buf.push(js.publish(subj, `${i}`));
  }

  await Promise.all(buf);

  const dc = new DirectConsumer(
    "A",
    new DirectStreamAPIImpl(nc),
    { seq: 0 } as DirectStartOptions,
  );

  dc.debug();

  let nexts = 0;

  (async () => {
    for await (const s of dc.status()) {
      switch (s.type) {
        case "next":
          nexts += s.options.batch;
          break;
        default:
          // nothing
      }
    }
  })().catch();

  const iter = await dc.consume({ batch: 7 });
  for await (const m of iter) {
    if (m.pending === 0) {
      break;
    }
  }

  assertEquals(iter.getProcessed(), 100);
  assert(nexts > 100);

  await cleanup(ns, nc);
});
