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
import { cleanup, jetstreamServerConf, notCompatible, setup } from "nst";
import { deferred, delay } from "@nats-io/nats-core";
import type { NatsConnectionImpl } from "@nats-io/nats-core/internal";
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

Deno.test("direct consumer - no responders reports 503", async () => {
  // no jetstream, so nothing answers the direct get
  const { ns, nc } = await setup();
  (nc as NatsConnectionImpl).features.update("2.12.0");

  const dc = new DirectConsumer(
    "A",
    new DirectStreamAPIImpl(nc),
    { seq: 0 } as DirectStartOptions,
  );
  const code = deferred<number>();
  (async () => {
    for await (const s of dc.status()) {
      if (s.type === "debug" && s.code !== 0) {
        code.resolve(s.code);
      }
    }
  })().catch();

  const iter = await dc.consume({ batch: 10 });
  assertEquals(await code, 503);
  iter.stop();
  await cleanup(ns, nc);
});

async function countPulls(
  dc: DirectConsumer,
  ms: number,
): Promise<number> {
  let nexts = 0;
  (async () => {
    for await (const s of dc.status()) {
      if (s.type === "next") {
        nexts++;
      }
    }
  })().catch();
  const iter = await dc.consume({ batch: 10 });
  await delay(ms);
  iter.stop();
  return nexts;
}

Deno.test("direct consumer - empty stream doesn't spin", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.12.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"], allow_direct: true });
  const dc = new DirectConsumer(
    "A",
    new DirectStreamAPIImpl(nc),
    { seq: 0 } as DirectStartOptions,
  );
  // the first pull finds nothing, the next waits
  assertEquals(await countPulls(dc, 1000), 1);
  await cleanup(ns, nc);
});

Deno.test("direct consumer - errors don't spin", async () => {
  // no jetstream, so every pull fails
  const { ns, nc } = await setup();
  (nc as NatsConnectionImpl).features.update("2.12.0");
  const dc = new DirectConsumer(
    "A",
    new DirectStreamAPIImpl(nc),
    { seq: 0 } as DirectStartOptions,
  );
  assertEquals(await countPulls(dc, 1000), 1);
  await cleanup(ns, nc);
});

Deno.test("direct consumer - empty stream gets new messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.12.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"], allow_direct: true });
  const dc = new DirectConsumer(
    "A",
    new DirectStreamAPIImpl(nc),
    { seq: 0 } as DirectStartOptions,
  );
  const iter = await dc.consume({ batch: 10 });
  await delay(250);
  await jsm.jetstream().publish("a", "hello");
  for await (const m of iter) {
    assertEquals(m.string(), "hello");
    break;
  }
  await cleanup(ns, nc);
});

Deno.test("direct consumer - stop during a pull doesn't sleep", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.12.0")) {
    return;
  }
  // a responder that never answers, so the pull stays in flight
  const requested = deferred<void>();
  nc.subscribe("$JS.API.DIRECT.GET.fake", {
    callback: () => {
      requested.resolve();
    },
  });
  await nc.flush();

  const dc = new DirectConsumer(
    "fake",
    new DirectStreamAPIImpl(nc),
    { seq: 0 } as DirectStartOptions,
  );
  const notifications: string[] = [];
  (async () => {
    for await (const s of dc.status()) {
      notifications.push(
        s.type === "debug" ? s.description : s.type,
      );
    }
  })().catch();

  const iter = await dc.consume({ batch: 10 });
  await requested;
  iter.stop();
  await delay(100);
  // stopped mid-pull, the loop exits instead of sleeping
  assertEquals(notifications.filter((n) => n.startsWith("sleeping")), []);
  assertEquals(notifications.filter((n) => n === "next").length, 1);

  await cleanup(ns, nc);
});
