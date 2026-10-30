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
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertIsError,
  assertRejects,
  fail,
} from "@std/assert";

import { deferred, delay, errors, headers } from "@nats-io/nats-core";
import type { Delay } from "@nats-io/nats-core";

import {
  jetstream,
  JetStreamError,
  jetstreamManager,
  StorageType,
  type StoredMsg,
} from "../src/mod.ts";
import {
  assertBetween,
  cleanup,
  jetstreamServerConf,
  notCompatible,
  notSupported,
  setup,
} from "nst";

import { JetStreamStatusError } from "../src/jserrors.ts";

import type { JetStreamManagerImpl } from "../src/jsclient.ts";
import type { DirectBatchOptions, DirectLastFor } from "../src/jsapi_types.ts";
import type {
  NatsConnection,
  NatsConnectionImpl,
  QueuedIteratorImpl,
} from "@nats-io/nats-core/internal";

Deno.test("direct - version checks", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  assertExists(nc.info);
  nc.info.version = "2.0.0";
  (nc as NatsConnectionImpl).features.update("2.0.0");

  const jsm = await jetstreamManager(nc) as JetStreamManagerImpl;

  await assertRejects(
    () => {
      return jsm.direct.getMessage("A", { start_time: new Date() });
    },
    Error,
    "start_time direct option require server 2.11.0",
  );

  await assertRejects(
    () => {
      return jsm.direct.getBatch(
        "A",
        { seq: 1, batch: 100 },
      );
    },
    Error,
    "batch direct require server 2.11.0",
  );

  await assertRejects(
    () => {
      return jsm.direct.getBatch(
        "A",
        { seq: 1, batch: 100 },
      );
    },
    Error,
    "batch direct require server 2.11.0",
  );

  await cleanup(ns, nc);
});

Deno.test("direct - decoder", async (t) => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a", "b"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  const js = jetstream(nc);
  await js.publish("a", "hello world");
  await js.publish("b", JSON.stringify({ hello: "world" }));

  await t.step("string", async () => {
    const m = await jsm.direct.getMessage("A", { seq: 1 });
    assertExists(m);
    assertEquals(m.string(), "hello world");
  });

  await t.step("json", async () => {
    const m = await jsm.direct.getMessage("A", { seq: 2 });
    assertExists(m);
    assertEquals(m.json(), { hello: "world" });
  });

  await cleanup(ns, nc);
});

Deno.test("direct - get", async (t) => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a.>", "b.>", "z.a"],
    storage: StorageType.File,
    allow_direct: true,
  });

  const js = jetstream(nc);

  await Promise.all([
    js.publish(`a.1`, "<payload>"),
    js.publish(`b.1`, "<payload>"),
  ]);

  await delay(1000);

  await Promise.all([
    js.publish(`z.a`, new Uint8Array(15)),
    js.publish(`a.2`, "<payload>"),
    js.publish(`b.2`, "<payload>"),
    js.publish(`z.a`, new Uint8Array(15)),
    js.publish(`a.3`, "<payload>"),
    js.publish(`b.3`, "<payload>"),
    js.publish(`z.a`, new Uint8Array(15)),
    js.publish(`a.4`, "<payload>"),
    js.publish(`b.4`, "<payload>"),
    js.publish(`z.a`, new Uint8Array(15)),
    js.publish(`a.5`, "<payload>"),
    js.publish(`b.5`, "<payload>"),
    js.publish(`z.a`, new Uint8Array(15)),
    js.publish(`a.6`, "<payload>"),
    js.publish(`b.6`, "<payload>"),
    js.publish(`z.a`, new Uint8Array(15)),
    js.publish(`a.7`, "<payload>"),
    js.publish(`b.7`, "<payload>"),
    js.publish(`z.a`, new Uint8Array(15)),
    js.publish(`a.8`, "<payload>"),
    js.publish(`b.8`, "<payload>"),
    js.publish(`z.a`, new Uint8Array(15)),
  ]);

  // const c = await js.consumers.get("A");
  // const iter = await c.fetch({ max_messages: 24 });
  // for await (const m of iter) {
  //   console.log(m.seq, m.subject);
  // }

  await assertRejects(
    () => {
      return jsm.direct.getMessage("A", { seq: 0 });
    },
    JetStreamError,
    "empty request",
  );

  await t.step("seq", async () => {
    const m = await jsm.direct.getMessage("A", { seq: 1 });
    assertExists(m);
    assertEquals(m.seq, 1);
    assertEquals(m.subject, "a.1");
  });

  await t.step("first with subject", async () => {
    const m = await jsm.direct.getMessage("A", { next_by_subj: "z.a" });
    assertExists(m);
    assertEquals(m.seq, 3);
  });

  await t.step("next with subject from sequence", async () => {
    const m = await jsm.direct.getMessage("A", { seq: 4, next_by_subj: "z.a" });
    assertExists(m);
    assertEquals(m.seq, 6);
  });

  await t.step("start_time", async () => {
    if (await notSupported(ns, "2.11.0")) {
      return Promise.resolve();
    }
    const start_time = (await jsm.direct.getMessage("A", { seq: 3 }))?.time;
    assertExists(start_time);
    const m = await jsm.direct.getMessage("A", { start_time });
    assertExists(m);
    assertEquals(m?.seq, 3);
    assertEquals(m?.subject, "z.a");
  });

  await t.step("last_by_subject", async () => {
    const m = await jsm.direct.getMessage("A", { last_by_subj: "z.a" });
    assertExists(m);
    assertEquals(m.seq, 24);
    assertEquals(m.subject, "z.a");
  });

  await cleanup(ns, nc);
});

Deno.test("direct - callback", async (t) => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const nci = nc as NatsConnectionImpl;
  const jsm = await jetstreamManager(nci) as JetStreamManagerImpl;

  await t.step("no stream", async () => {
    const d = deferred();
    const iter = await jsm.direct.getBatch("hello", {
      seq: 1,
      callback: (done, _) => {
        assertExists(done);
        assertIsError(done.err, Error, "no responders");
        d.resolve();
      },
    }) as QueuedIteratorImpl<StoredMsg>;

    const err = await iter.iterClosed;
    assertIsError(err, Error, "no responders");
  });

  await t.step("message not found", async () => {
    await jsm.streams.add({
      name: "empty",
      subjects: ["empty"],
      storage: StorageType.Memory,
      allow_direct: true,
    });

    const iter = await jsm.direct.getBatch("empty", {
      //@ts-ignore: test
      seq: 1,
      callback: (done, _) => {
        assertExists(done);
        assertIsError(done.err, JetStreamStatusError, "message not found");
      },
    }) as QueuedIteratorImpl<StoredMsg>;

    const err = await iter.iterClosed;
    assertIsError(err, JetStreamStatusError, "message not found");
  });

  await t.step("6 messages", async () => {
    await jsm.streams.add({
      name: "A",
      subjects: ["a.*"],
      storage: StorageType.Memory,
      allow_direct: true,
    });

    const js = jetstream(nc);
    await Promise.all([
      js.publish("a.a"),
      js.publish("a.b"),
      js.publish("a.c"),
    ]);

    const buf: StoredMsg[] = [];

    const iter = await jsm.direct.getBatch("A", {
      batch: 10,
      seq: 1,
      callback: (done, sm) => {
        if (done) {
          if (done.err) {
            console.log(done.err);
            fail(done.err.message);
          }
          return;
        }
        buf.push(sm);
      },
    }) as QueuedIteratorImpl<StoredMsg>;

    const err = await iter.iterClosed;
    assertEquals(err, undefined);

    const subj = buf.map((m) => m.subject);
    assertEquals(subj.length, 3);
    assertEquals(subj[0], "a.a");
    assertEquals(subj[1], "a.b");
    assertEquals(subj[2], "a.c");
  });

  await cleanup(ns, nc);
});

Deno.test("direct - batch", async (t) => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const nci = nc as NatsConnectionImpl;
  const jsm = await jetstreamManager(nci) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a.>"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  const js = jetstream(nc);
  const d = deferred();
  let i = 0;
  const timer = setInterval(async () => {
    i++;
    await js.publish(`a.a`, new Uint8Array(i));
    if (i === 8) {
      clearInterval(timer);
      d.resolve();
    }
  }, 250);
  await d;

  type tt = {
    opts: DirectBatchOptions;
    expect: number[];
  };

  async function assertBatch(tc: tt, debug = false): Promise<void> {
    if (debug) {
      nci.options.debug = true;
    }
    const iter = await jsm.direct.getBatch("A", tc.opts);
    const buf: number[] = [];
    for await (const m of iter) {
      buf.push(m.seq);
    }
    if (debug) {
      nci.options.debug = false;
    }
    assertArrayIncludes(buf, tc.expect);
    assertEquals(buf.length, tc.expect.length);
  }

  async function getDateFor(seq: number): Promise<Date> {
    const m = await jsm.direct.getMessage("A", { seq: seq });
    assertExists(m);
    assertEquals(m.seq, seq);
    return m.time;
  }

  await t.step("fails without any option in addition to batch", async () => {
    await assertRejects(
      () => {
        return assertBatch({
          opts: {
            batch: 3,
          } as DirectBatchOptions,
          expect: [],
        });
      },
      JetStreamError,
      "empty request",
    );
  });

  await t.step("start sequence", () => {
    return assertBatch({
      //@ts-ignore: test
      opts: {
        batch: 3,
        seq: 3,
      },
      expect: [3, 4, 5],
    });
  });

  await t.step("start sequence are mutually exclusive start_time", async () => {
    const start_time = await getDateFor(3);
    await assertRejects(
      () => {
        return assertBatch({
          //@ts-ignore: test
          opts: {
            seq: 100,
            start_time,
          },
          expect: [3, 4, 5],
        });
      },
      JetStreamError,
      "bad request",
    );
  });

  await t.step("start_time", async () => {
    const start_time = await getDateFor(3);
    await assertBatch({
      //@ts-ignore: test
      opts: {
        start_time,
        batch: 10,
      },
      expect: [3, 4, 5, 6, 7, 8],
    });
  });

  await t.step("max_bytes", async () => {
    await assertBatch({
      //@ts-ignore: test
      opts: {
        seq: 1,
        max_bytes: 4,
      },
      expect: [1],
    });
  });
  await cleanup(ns, nc);
});

Deno.test("direct - last message for", async (t) => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const nci = nc as NatsConnectionImpl;
  const jsm = await jetstreamManager(nci) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a", "b", "z"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  const js = jetstream(nc);
  await Promise.all([
    js.publish("a", "1"),
    js.publish("a", "2"),
    js.publish("a", "last a"),
    js.publish("b", "1"),
  ]);
  await delay(100);
  await Promise.all([
    js.publish("b", "last b"),
    js.publish("z", "last z"),
  ]);

  type tt = {
    opts: DirectLastFor;
    expect: number[];
  };

  async function assertBatch(tc: tt, debug = false): Promise<void> {
    if (debug) {
      nci.options.debug = true;
    }
    const iter = await jsm.direct.getLastMessagesFor("A", tc.opts);
    const buf: number[] = [];
    for await (const m of iter) {
      buf.push(m.seq);
    }
    if (debug) {
      nci.options.debug = false;
    }
    assertArrayIncludes(buf, tc.expect);
    assertEquals(buf.length, tc.expect.length);
  }

  async function getDateFor(seq: number): Promise<Date> {
    const m = await jsm.direct.getMessage("A", { seq: seq });
    assertExists(m);
    assertEquals(m.seq, seq);
    return m.time;
  }

  await t.step("not matched filter", async () => {
    await assertBatch({ opts: { multi_last: ["c"] }, expect: [] });
  });

  await t.step("single filter", async () => {
    await assertBatch({ opts: { multi_last: ["a"] }, expect: [3] });
  });

  await t.step("multiple filter", async () => {
    await assertBatch({
      opts: { multi_last: ["a", "b", "z"] },
      expect: [3, 5, 6],
    });
  });

  await t.step("up_to_time", async () => {
    const up_to_time = await getDateFor(5);
    await assertBatch(
      { opts: { up_to_time, multi_last: ["a", "b", "z"] }, expect: [3, 4] },
    );
  });

  await t.step("up_to_seq", async () => {
    await assertBatch(
      { opts: { up_to_seq: 4, multi_last: ["a", "b", "z"] }, expect: [3, 4] },
    );
  });

  await cleanup(ns, nc);
});

Deno.test("direct - batch next_by_subj", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const nci = nc as NatsConnectionImpl;
  const jsm = await jetstreamManager(nci) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a", "b"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  const js = jsm.jetstream();

  const buf = [];
  for (let i = 0; i < 50; i++) {
    buf.push(js.publish(`a`), buf.push(js.publish(`b`)));
  }
  await Promise.all(buf);

  const msgs = [];
  let iter = await jsm.direct.getBatch("A", {
    seq: 0,
    batch: 100,
    next_by_subj: "a",
  });
  for await (const m of iter) {
    msgs.push(m.subject);
  }
  assertEquals(msgs.length, 50);
  for (let i = 0; i < 50; i++) {
    assertEquals(msgs[i], "a");
  }

  msgs.length = 0;
  iter = await jsm.direct.getBatch("A", {
    seq: 50,
    batch: 100,
    next_by_subj: "b",
  });
  for await (const m of iter) {
    msgs.push(m.subject);
  }
  assertEquals(msgs.length, 26);
  for (let i = 0; i < 26; i++) {
    assertEquals(msgs[i], "b");
  }

  await cleanup(ns, nc);
});

Deno.test("direct - batch no messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf(), { debug: true });
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const nci = nc as NatsConnectionImpl;
  const jsm = await jetstreamManager(nci) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a", "b", "z"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  const iter = await jsm.direct.getLastMessagesFor("A", {
    multi_last: ["a", "b", "z"],
    batch: 100,
  });
  for await (const m of iter) {
    console.log(m.seq);
  }
  assertEquals(iter.getProcessed(), 0);

  await cleanup(ns, nc);
});

Deno.test("direct - get no messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf(), { debug: true });
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const nci = nc as NatsConnectionImpl;
  const jsm = await jetstreamManager(nci) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a", "b", "z"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  const m = await jsm.direct.getMessage("A", { last_by_subj: "a" });
  assertEquals(m, null);

  await cleanup(ns, nc);
});

Deno.test("direct - batch get honors api timeouts", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  // a silent direct get: requests are received but never answered
  const payloads: Record<string, unknown>[] = [];
  nc.subscribe("$JS.API.DIRECT.GET.silent", {
    callback: (_, m) => {
      payloads.push(m.json());
    },
  });
  await nc.flush();

  async function batch(
    timeout: number,
    perCall?: number,
    last = false,
  ): Promise<number> {
    const jsm = await jetstreamManager(nc, { timeout, checkAPI: false });
    const start = Date.now();
    const iter = last
      ? await jsm.direct.getLastMessagesFor("silent", {
        multi_last: ["a"],
        timeout: perCall,
      })
      : await jsm.direct.getBatch("silent", { seq: 1, timeout: perCall });
    try {
      for await (const _ of iter) {
        // nothing
      }
    } catch (err) {
      assertIsError(err, Error, "timeout");
      return Date.now() - start;
    }
    throw new Error("should have failed");
  }

  // the client's timeout, not a fixed 5s
  assertBetween(await batch(500), 450, 700);
  assertBetween(await batch(500, undefined, true), 450, 700);
  // a per-call timeout overrides it, shorter or longer
  assertBetween(await batch(500, 200), 150, 400);
  assertBetween(await batch(500, 900), 850, 1100);
  // the timeout is not sent to the server
  assert(payloads.length > 0);
  for (const p of payloads) {
    assertEquals(p.timeout, undefined);
  }

  await cleanup(ns, nc);
});

// replies 100ms apart, then stalls or ends the batch
function slowDirect(
  nc: NatsConnection,
  stream: string,
  count: number,
  eob: boolean,
): void {
  // the test can end before the responder is done - don't leak its timers
  const pending = new Set<Delay>();
  nc.closed().then(() => {
    pending.forEach((d) => d.cancel());
  });
  nc.subscribe(`$JS.API.DIRECT.GET.${stream}`, {
    callback: (_, m) => {
      (async () => {
        for (let i = 0; i < count; i++) {
          const d = delay(100);
          pending.add(d);
          await d;
          pending.delete(d);
          if (nc.isClosed()) {
            return;
          }
          const h = headers();
          h.set("Nats-Stream", stream);
          h.set("Nats-Subject", "a");
          h.set("Nats-Sequence", `${i + 1}`);
          h.set("Nats-Time-Stamp", new Date().toISOString());
          h.set("Nats-Num-Pending", `${count - i - 1}`);
          nc.publish(m.reply!, `${i}`, { headers: h });
        }
        if (eob) {
          nc.publish(m.reply!, undefined, { headers: headers(204, "EOB") });
        }
      })().catch(() => {
        // the connection may close before the responder is done
      });
    },
  });
}

Deno.test("direct - batch get timeout is per reply", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  slowDirect(nc, "slow", 10, true);
  slowDirect(nc, "stall", 3, false);
  await nc.flush();
  const jsm = await jetstreamManager(nc, { timeout: 300, checkAPI: false });

  // takes about a second, longer than the timeout, but never waits 300ms
  let iter = await jsm.direct.getBatch("slow", { seq: 1 });
  let n = 0;
  for await (const _ of iter) {
    n++;
  }
  assertEquals(n, 10);

  // a stall after the third reply fails after the timeout
  iter = await jsm.direct.getBatch("stall", { seq: 1 });
  n = 0;
  const start = Date.now();
  try {
    for await (const _ of iter) {
      n++;
    }
    fail("should have timed out");
  } catch (err) {
    assertIsError(err, Error, "timeout");
  }
  assertEquals(n, 3);
  assertBetween(Date.now() - start, 550, 900);

  await cleanup(ns, nc);
});

Deno.test("direct - batch get stall fails the callback", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  slowDirect(nc, "stall", 3, false);
  await nc.flush();
  const jsm = await jetstreamManager(nc, { timeout: 300, checkAPI: false });

  const d = deferred<Error | undefined>();
  let n = 0;
  await jsm.direct.getBatch("stall", {
    seq: 1,
    callback: (done, _) => {
      if (done) {
        d.resolve(done.err);
        return;
      }
      n++;
    },
  });
  const err = await d;
  assertIsError(err, Error, "timeout");
  assertEquals(n, 3);
  await cleanup(ns, nc);
});

Deno.test("direct - batch get timeout ends with the batch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const nci = nc as NatsConnectionImpl;
  const jsm = await jetstreamManager(nc, { timeout: 2000 });
  await jsm.streams.add({ name: "A", subjects: ["a"], allow_direct: true });
  const js = jsm.jetstream();
  await Promise.all([js.publish("a"), js.publish("a"), js.publish("a")]);
  const subs = nci.protocol.subscriptions.size();
  const reqs = nci.protocol.muxSubscriptions.size();

  // the batch is complete when the server sends it, not when it is read
  const iter = await jsm.direct.getBatch("A", { seq: 1 });
  await delay(250);
  assertEquals(nci.protocol.subscriptions.size(), subs);
  assertEquals(nci.protocol.muxSubscriptions.size(), reqs);

  let n = 0;
  for await (const _ of iter) {
    n++;
  }
  assertEquals(n, 3);

  await cleanup(ns, nc);
});

Deno.test("direct - stopping a batch ends the request", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const nci = nc as NatsConnectionImpl;
  slowDirect(nc, "slow", 10, true);
  await nc.flush();
  const jsm = await jetstreamManager(nc, { timeout: 2000, checkAPI: false });
  const reqs = nci.protocol.muxSubscriptions.size();

  const iter = await jsm.direct.getBatch("slow", { seq: 1 });
  let n = 0;
  // stopping is not a timeout
  for await (const _ of iter) {
    n++;
    if (n === 2) {
      break;
    }
  }
  assertEquals(n, 2);
  await delay(50);
  assertEquals(nci.protocol.muxSubscriptions.size(), reqs);

  await cleanup(ns, nc);
});

Deno.test("direct - single reply is delivered", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  // a server that answers with a single message, no batch
  nc.subscribe("$JS.API.DIRECT.GET.single", {
    callback: (_, m) => {
      const h = headers();
      h.set("Nats-Stream", "single");
      h.set("Nats-Subject", "a");
      h.set("Nats-Sequence", "1");
      h.set("Nats-Time-Stamp", new Date().toISOString());
      m.respond("hello", { headers: h });
    },
  });
  await nc.flush();
  const jsm = await jetstreamManager(nc, { timeout: 1000, checkAPI: false });

  const iter = await jsm.direct.getLastMessagesFor("single", {
    multi_last: ["a"],
  });
  const buf: string[] = [];
  for await (const m of iter) {
    buf.push(m.string());
  }
  assertEquals(buf, ["hello"]);

  await cleanup(ns, nc);
});

Deno.test("direct - stopping from the callback ends delivery", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"], allow_direct: true });
  const js = jsm.jetstream();
  for (let i = 0; i < 10; i++) {
    await js.publish("a", `${i}`);
  }

  const calls: string[] = [];
  const d = deferred();
  const iter = await jsm.direct.getBatch("A", {
    seq: 1,
    callback: (done, sm) => {
      if (done) {
        calls.push(`done:${done.err}`);
        d.resolve();
        return;
      }
      calls.push(sm.string());
      if (calls.length === 2) {
        iter.stop();
      }
    },
  });
  await d;
  await delay(100);
  // done is the last callback, nothing is delivered after the stop
  assertEquals(calls, ["0", "1", "done:undefined"]);

  await cleanup(ns, nc);
});

Deno.test("direct - batch no responders", async () => {
  // no jetstream, so nothing answers the direct get
  const { ns, nc } = await setup();
  (nc as NatsConnectionImpl).features.update("2.11.0");
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  const iter = await jsm.direct.getBatch("A", { seq: 1 });
  await assertRejects(
    async () => {
      for await (const _ of iter) {
        // nothing
      }
    },
    errors.NoRespondersError,
  );
  await cleanup(ns, nc);
});
