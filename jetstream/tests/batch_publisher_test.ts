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

  const bp = await js.batchPublisher("q", "a");
  for (let i = 0; i < 98; i++) {
    bp.publish("q", i.toString(), { ack: i % 20 === 0 });
  }
  const end = await bp.end("q", "lastone");
  assertEquals(end.seq, 100);
  assertEquals(end.stream, "batch");
  assertEquals(end.count, 100);
  assertEquals(end.batch, bp.id);

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
  const bp = await js.batchPublisher("q", "a");
  const bpi = bp as BatchPublisherImpl;
  bpi.seq++;

  await assertRejects(
    () => {
      return bp.end("q", "c");
    },
    Error,
    "batch didn't contain number of published messages",
  );

  await cleanup(ns, nc);
});
