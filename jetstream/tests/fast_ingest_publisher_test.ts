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

import {
  cleanup,
  jetstreamServerConf,
  notCompatible,
  setup,
} from "test_helpers";
import { jetstreamManager } from "../src/jsclient.ts";
import { assertEquals, assertRejects } from "@std/assert";

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

  const js = jsm.jetstream();

  const fi = await js.startFastIngest("q", "1", { ackInterval: 5 });
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

  const js = jsm.jetstream();

  await assertRejects(() => {
    return js.startFastIngest("q", "1", { ackInterval: 5 });
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

  const js = jsm.jetstream();

  const fi = await js.startFastIngest("q", "1", { ackInterval: 5 });
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

  const js = jsm.jetstream();

  const fi = await js.startFastIngest("q", "1", { ackInterval: 10 });
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

  const js = jsm.jetstream();

  // ackInterval=2, window=2*2=4 — forces blocking
  const fi = await js.startFastIngest("q", "1", { ackInterval: 2 });
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

  const js = jsm.jetstream();
  const fi = await js.startFastIngest("q", "1");
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

  const js = jsm.jetstream();
  const fi = await js.startFastIngest("q", "1", { inboxPrefix: "FI" });
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

  const js = jsm.jetstream();

  for (const bad of ["", " ", "has space", "*", ">", "foo.*", "foo.>"]) {
    await assertRejects(
      () => js.startFastIngest("q", "1", { inboxPrefix: bad }),
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

  const js = jsm.jetstream();
  const fi = await js.startFastIngest("q", "1", {
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

  const js = jsm.jetstream();
  const fi = await js.startFastIngest("q", "1", { ackInterval: 10 });
  await fi.add("q", "2");

  const [a, b] = await Promise.all([fi.ping(), fi.ping()]);
  assertEquals(a.batchSeq, b.batchSeq);
  assertEquals(a.ackSeq, b.ackSeq);

  await fi.last("q", "3");
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

  const js = jsm.jetstream();
  const fi = await js.startFastIngest("q", "1");
  await fi.add("q", "2");
  await fi.last("q", "3");

  const terminal = await fi.done();
  assertEquals(terminal.batch, fi.batch);
  assertEquals(terminal.count, 3);

  await cleanup(ns, nc);
});
