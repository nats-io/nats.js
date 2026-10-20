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
import {
  createFastIngest,
  jetstreamManager,
  startFastIngest,
} from "../src/jsclient.ts";
import type { FastIngest } from "../src/types.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { delay, errors } from "@nats-io/nats-core/internal";
import type { Msg, NatsConnection } from "@nats-io/nats-core";

Deno.test("fast ingest - basics", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  const fi = await startFastIngest(nc, "q", "1", {
    allowGaps: false,
    ackInterval: 5,
  });
  await fi.add("q", "2");
  await fi.add("q", "3");
  await fi.add("q", "4");
  const ack = await fi.last("q", "5");

  assertEquals(ack.stream, "batch");
  assertEquals(ack.batch, fi.batch);
  assertEquals(ack.count, 5);
  assertEquals(ack.seq, 5);

  const si = await jsm.streams.info("batch");
  assertEquals(si.state.messages, 5);

  await cleanup(ns, nc);
});

Deno.test("fast ingest - rejects non_supported", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    subjects: ["q"],
  });

  await assertRejects(() => {
    return startFastIngest(nc, "q", "1", { allowGaps: false, ackInterval: 5 });
  });

  const si = await jsm.streams.info("batch");
  assertEquals(si.state.messages, 0);

  await cleanup(ns, nc);
});

Deno.test("fast ingest - end (EOB)", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  const fi = await startFastIngest(nc, "q", "1", {
    allowGaps: false,
    ackInterval: 5,
  });
  await fi.add("q", "2");
  await fi.add("q", "3");
  const ack = await fi.end();

  assertEquals(ack.batch, fi.batch);
  assertEquals(ack.count, 3);

  const si = await jsm.streams.info("batch");
  assertEquals(si.state.messages, 3);

  await cleanup(ns, nc);
});

Deno.test("fast ingest - ping", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  const fi = await startFastIngest(nc, "q", "1", {
    allowGaps: false,
    ackInterval: 10,
  });
  await fi.add("q", "2");
  const p = await fi.ping();
  assertEquals(p.batchSeq, 2);

  const ack = await fi.last("q", "3");
  assertEquals(ack.count, 3);

  await cleanup(ns, nc);
});

Deno.test("fast ingest - backpressure", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  // ackInterval=2, window=2*2=4 — forces blocking
  const fi = await startFastIngest(nc, "q", "1", {
    allowGaps: false,
    ackInterval: 2,
  });
  for (let i = 2; i <= 20; i++) {
    await fi.add("q", i.toString());
  }
  const ack = await fi.last("q", "21");
  assertEquals(ack.count, 21);

  const si = await jsm.streams.info("batch");
  assertEquals(si.state.messages, 21);

  await cleanup(ns, nc);
});

Deno.test("fast ingest - add after closed rejects", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  const fi = await startFastIngest(nc, "q", "1", { allowGaps: false });
  await fi.last("q", "2");

  await assertRejects(
    () => fi.add("q", "3"),
    Error,
    "batch closed",
  );

  await cleanup(ns, nc);
});

Deno.test("fast ingest - custom inboxPrefix", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  const fi = await startFastIngest(nc, "q", "1", {
    allowGaps: false,
    inboxPrefix: "FI",
  });
  const ack = await fi.last("q", "2");
  assertEquals(ack.count, 2);

  await cleanup(ns, nc);
});

Deno.test("fast ingest - invalid inboxPrefix rejected", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  for (const bad of ["", " ", "has space", "*", ">", "foo.*", "foo.>"]) {
    await assertRejects(
      () =>
        startFastIngest(nc, "q", "1", { allowGaps: false, inboxPrefix: bad }),
      Error,
      "inboxPrefix",
    );
  }

  await cleanup(ns, nc);
});

Deno.test("fast ingest - multi-token inboxPrefix", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  const fi = await startFastIngest(nc, "q", "1", {
    allowGaps: false,
    inboxPrefix: "_inbox.foo.bar.baz",
  });
  await fi.add("q", "2");
  const ack = await fi.last("q", "3");
  assertEquals(ack.count, 3);

  await cleanup(ns, nc);
});

Deno.test("fast ingest - concurrent pings coalesce", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  const fi = await startFastIngest(nc, "q", "1", {
    allowGaps: false,
    ackInterval: 10,
  });
  await fi.add("q", "2");

  const [a, b] = await Promise.all([fi.ping(), fi.ping()]);
  assertEquals(a.batchSeq, b.batchSeq);
  assertEquals(a.ackSeq, b.ackSeq);

  await fi.last("q", "3");
  await cleanup(ns, nc);
});

Deno.test("fast ingest - expect.lastSequence on first msg", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  // first publish to advance the stream tip to 1
  await jsm.jetstream().publish("q", "0");

  // start a batch w/ correct expectation — should succeed
  const fi = await startFastIngest(nc, "q", "1", {
    allowGaps: false,
    expect: { lastSequence: 1 },
  });
  await fi.add("q", "2");
  const ack = await fi.last("q", "3");
  assertEquals(ack.count, 3);

  // stream now has 4 msgs (publish + 3 batch)
  const si = await jsm.streams.info("batch");
  assertEquals(si.state.messages, 4);

  await cleanup(ns, nc);
});

Deno.test("fast ingest - expect.lastSequence mismatch closes batch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  // stream is empty (last_seq=0); expecting 5 — server sends type:"err"
  // which closes the batch
  const fi = await startFastIngest(nc, "q", "1", {
    allowGaps: false,
    expect: { lastSequence: 5 },
  });

  await assertRejects(() => fi.last("q", "2"), Error);

  const si = await jsm.streams.info("batch");
  assertEquals(si.state.messages, 0);

  await cleanup(ns, nc);
});

Deno.test("fast ingest - done() resolves with terminal ack", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  const fi = await startFastIngest(nc, "q", "1", { allowGaps: false });
  await fi.add("q", "2");
  await fi.last("q", "3");

  const terminal = await fi.done();
  assertEquals(terminal.batch, fi.batch);
  assertEquals(terminal.count, 3);

  await cleanup(ns, nc);
});

Deno.test("fast ingest create - publishes nothing until add", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  await nc.flush();
  const before = nc.stats().outMsgs;

  const fi = createFastIngest(nc, { allowGaps: false });
  const p = await fi.ping();
  assertEquals(p, { batchSeq: 0, ackSeq: 0 });

  const ack = await fi.end();
  assertEquals(ack.batch, fi.batch);
  assertEquals(ack.count, 0);
  assertEquals(ack.seq, 0);
  assertEquals(await fi.done(), ack);

  await nc.flush();
  assertEquals(nc.stats().outMsgs, before);

  const si = await jsm.streams.info("batch");
  assertEquals(si.state.messages, 0);

  await assertRejects(() => fi.add("q", "1"), Error, "batch closed");

  await cleanup(ns, nc);
});

Deno.test("fast ingest create - first add starts the batch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  const fi = createFastIngest(nc, { allowGaps: false, ackInterval: 5 });
  const p = await fi.add("q", "1");
  assertEquals(p.batchSeq, 1);
  await fi.add("q", "2");
  const ack = await fi.last("q", "3");

  assertEquals(ack.stream, "batch");
  assertEquals(ack.batch, fi.batch);
  assertEquals(ack.count, 3);

  const si = await jsm.streams.info("batch");
  assertEquals(si.state.messages, 3);

  await cleanup(ns, nc);
});

Deno.test("fast ingest create - last before add stores one message", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  const fi = createFastIngest(nc, { allowGaps: false });
  const ack = await fi.last("q", "1");
  assertEquals(ack.batch, fi.batch);
  assertEquals(ack.count, 1);

  const si = await jsm.streams.info("batch");
  assertEquals(si.state.messages, 1);

  await cleanup(ns, nc);
});

Deno.test("fast ingest create - rejects maxOutstandingAcks outside 1-3", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });

  await nc.flush();
  const before = nc.stats().outMsgs;

  for (const bad of [0, 4, -1, 1.5, NaN]) {
    assertThrows(
      () => createFastIngest(nc, { allowGaps: false, maxOutstandingAcks: bad }),
      errors.InvalidArgumentError,
      "maxOutstandingAcks",
    );
    await assertRejects(
      () =>
        startFastIngest(nc, "q", "1", {
          allowGaps: false,
          maxOutstandingAcks: bad,
        }),
      errors.InvalidArgumentError,
      "maxOutstandingAcks",
    );
  }
  for (const good of [1, 2, 3]) {
    createFastIngest(nc, { allowGaps: false, maxOutstandingAcks: good });
  }

  await nc.flush();
  assertEquals(nc.stats().outMsgs, before);

  await cleanup(ns, nc);
});

Deno.test("fast ingest create - invalid inboxPrefix throws", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  for (const bad of ["", " ", "has space", "*", ">", "foo.*", "foo.>"]) {
    assertThrows(
      () => createFastIngest(nc, { allowGaps: false, inboxPrefix: bad }),
      Error,
      "inboxPrefix",
    );
  }
  await cleanup(ns, nc);
});

// dropFlowAcks makes the batch lose the flow acks the server sends for an
// append (op 1) whose batch sequence is in seqs, as if they were lost on the
// way. Acks for pings (op 4) are kept, so a ping recovers them.
function dropFlowAcks(fi: FastIngest, seqs: number[]): string[] {
  const dropped: string[] = [];
  // deno-lint-ignore no-explicit-any
  const impl = fi as any;
  const route = impl.route.bind(impl);
  impl.route = (err: Error | null, m: Msg) => {
    const tokens = m?.subject.split(".") ?? [];
    const op = Number(tokens[tokens.length - 2]);
    const seq = Number(tokens[tokens.length - 3]);
    if (!err && op === 1 && seqs.includes(seq)) {
      dropped.push(m.subject);
      return;
    }
    route(err, m);
  };
  return dropped;
}

// pings records the batch sequence of every ping published to subj.
function pings(nc: NatsConnection, subj: string): number[] {
  const seqs: number[] = [];
  nc.subscribe(subj, {
    callback: (_err, m) => {
      const tokens = m.reply?.split(".") ?? [];
      if (tokens[tokens.length - 2] === "4") {
        seqs.push(Number(tokens[tokens.length - 3]));
      }
    },
  });
  return seqs;
}

async function batchStream(nc: NatsConnection) {
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_batched: true,
    subjects: ["q"],
  });
  return jsm;
}

Deno.test("fast ingest ping - a blocked add pings to recover a lost ack", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  const jsm = await batchStream(nc);
  const seen = pings(nc, "q");

  // window is 2 * 2 = 4: with the acks for 4 and 6 lost, the add of 6
  // blocks, and only the ack a ping brings back releases it
  const fi = createFastIngest(nc, {
    allowGaps: false,
    ackInterval: 2,
    maxOutstandingAcks: 2,
  }, 3000);
  const dropped = dropFlowAcks(fi, [4, 6]);

  const start = Date.now();
  for (let i = 1; i <= 10; i++) {
    await fi.add("q", `${i}`);
  }
  const ack = await fi.last("q", "11");
  const took = Date.now() - start;

  assertEquals(ack.count, 11);
  assertEquals(dropped.length, 2);
  assert(seen.length >= 1, "no ping was sent");
  // the first ping goes out a third of the way into the 3s timeout
  assert(took >= 900 && took < 3000, `took ${took}ms`);

  const si = await jsm.streams.info("batch");
  assertEquals(si.state.messages, 11);

  await cleanup(ns, nc);
});

Deno.test("fast ingest ping - carries the highest sent batch sequence", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  await batchStream(nc);
  const seen = pings(nc, "q");

  const fi = createFastIngest(nc, {
    allowGaps: false,
    ackInterval: 2,
    maxOutstandingAcks: 2,
  }, 1500);
  dropFlowAcks(fi, [4, 6]);

  for (let i = 1; i <= 6; i++) {
    await fi.add("q", `${i}`);
  }
  const p = await fi.add("q", "7");
  assertEquals(p.batchSeq, 7);
  await fi.end();
  await nc.flush();

  // the add of 6 blocked, so every ping carried 6, not 7
  assert(seen.length >= 1, "no ping was sent");
  for (const s of seen) {
    assertEquals(s, 6);
  }

  await cleanup(ns, nc);
});

Deno.test("fast ingest ping - an idle batch is not pinged", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  await batchStream(nc);
  const seen = pings(nc, "q");

  const fi = createFastIngest(nc, { allowGaps: false }, 300);
  await fi.add("q", "1");
  await fi.add("q", "2");

  // well past the timeout, with nothing waiting on the server
  await delay(1000);
  await nc.flush();
  assertEquals(seen.length, 0);

  const ack = await fi.end();
  assertEquals(ack.count, 2);

  await cleanup(ns, nc);
});

Deno.test("fast ingest ping - pings stop at the timeout", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  await batchStream(nc);
  const seen = pings(nc, "q");

  const fi = createFastIngest(nc, {
    allowGaps: false,
    ackInterval: 2,
    maxOutstandingAcks: 1,
  }, 600);
  // every ack after the start is lost, the ones for pings included, so
  // nothing recovers the batch
  // deno-lint-ignore no-explicit-any
  const impl = fi as any;
  const route = impl.route.bind(impl);
  impl.route = (err: Error | null, m: Msg) => {
    if (!err && m.subject.endsWith(".0.$FI")) route(err, m);
  };

  // window is 2 and the start ack acknowledges no message: the add of 2
  // blocks
  await fi.add("q", "1");
  await assertRejects(() => fi.add("q", "2"));

  await nc.flush();
  const count = seen.length;
  await delay(600);
  await nc.flush();
  assertEquals(seen.length, count);

  await cleanup(ns, nc);
});

Deno.test("fast ingest ping - calls blocked together send one ping", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }
  await batchStream(nc);
  const seen = pings(nc, "q");

  const fi = createFastIngest(nc, {
    allowGaps: false,
    ackInterval: 2,
    maxOutstandingAcks: 2,
  }, 3000);
  // every flow ack after the one for 2 is lost, so only the ack a ping
  // brings back releases the blocked adds
  dropFlowAcks(fi, [4, 6, 8, 10]);

  for (let i = 1; i <= 5; i++) {
    await fi.add("q", `${i}`);
  }
  // the adds of 6 to 10 all block on the window at once
  const blocked = [];
  for (let i = 6; i <= 10; i++) {
    blocked.push(fi.add("q", `${i}`));
  }
  await Promise.all(blocked);
  await nc.flush();

  assertEquals(seen, [10]);

  const ack = await fi.end();
  assertEquals(ack.count, 10);

  await cleanup(ns, nc);
});
