/*
 * Copyright 2025 The NATS Authors
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
import { type BatchPublisherImpl, jetstreamManager } from "../src/jsclient.ts";
import { assertEquals, assertRejects } from "@std/assert";

Deno.test("batch publisher - basics", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "batch",
    allow_atomic: true,
    subjects: ["q"],
  });

  const js = jsm.jetstream();

  const bp = await js.startBatch("q", "a");
  for (let i = 0; i < 98; i++) {
    bp.add("q", i.toString(), { ack: i % 20 === 0 });
  }
  const ack = await bp.commit("q", "lastone");
  assertEquals(ack.seq, 100);
  assertEquals(ack.stream, "batch");
  assertEquals(ack.count, 100);
  assertEquals(ack.batch, bp.id);

  await cleanup(ns, nc);
});

Deno.test("batch publisher - out of sequence", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({
    name: "batch",
    allow_atomic: true,
    subjects: ["q"],
  });

  const js = jsm.jetstream();
  const bp = await js.startBatch("q", "a");
  const bpi = bp as BatchPublisherImpl;
  bpi.count++;

  await assertRejects(
    () => {
      return bp.commit("q", "c");
    },
    Error,
    "batch didn't contain number of published messages",
  );

  await cleanup(ns, nc);
});

Deno.test("batch publisher - two streams", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "a",
    allow_atomic: true,
    subjects: ["a"],
  });

  await jsm.streams.add({
    name: "b",
    allow_atomic: true,
    subjects: ["b"],
  });

  const js = jsm.jetstream();

  const bp = await js.startBatch("a", "a");

  await assertRejects(
    () => {
      return bp.add("b", "b", { ack: true });
    },
    Error,
    "atomic publish batch is incomplete",
  );

  await assertRejects(
    () => {
      return bp.commit("a", "a");
    },
    Error,
    "batch publisher is done",
  );

  const si = await jsm.streams.info("b");
  assertEquals(si.state.messages, 0);

  await cleanup(ns, nc);
});

Deno.test("batch publisher - expect last seq", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "a",
    allow_atomic: true,
    subjects: ["a"],
  });

  const js = jsm.jetstream();

  // this should have failed...
  const b = await js.startBatch("a", "a", {
    expect: {
      lastSequence: 5,
    },
  });
  // this fails but the message is doggy
  await assertRejects(
    () => {
      return b.commit("a", "");
    },
    Error,
    "batch didn't contain number of published messages",
  );

  await cleanup(ns, nc);
});

Deno.test("batch publisher - no atomics", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "a",
    subjects: ["a"],
  });

  const js = jsm.jetstream();
  await assertRejects(
    () => {
      return js.startBatch("a", "a");
    },
    Error,
    "atomic publish is disabled",
  );

  await cleanup(ns, nc);
});
