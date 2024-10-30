/*
 * Copyright 2018-2023 The NATS Authors
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
import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { Bench, createInbox, Metric } from "../src/mod.ts";
import { connect } from "./connect.ts";
import type { BenchOpts } from "../src/mod.ts";

const u = "demo.nats.io:4222";

async function runBench(opts: BenchOpts): Promise<Metric[]> {
  const nc = await connect({ servers: u });
  const bench = new Bench(nc, opts);
  const m = await bench.run();
  await nc.close();
  return m;
}

function pubSub(m: Metric[]) {
  assertEquals(m.length, 3);
  const pubsub = m.find((v) => {
    return v.name === "pubsub";
  });
  assert(pubsub);

  const sub = m.find((v) => {
    return v.name === "sub";
  });
  assert(sub);

  const pub = m.find((v) => {
    return v.name === "pub";
  });
  assert(pub);

  m.forEach((v) => {
    assertEquals(v.payload, 8);
    assert(v.lang);
    assert(v.version);
    assert(v.toString() !== "");
    csv(v);
  });
}

function reqRep(m: Metric[]) {
  assertEquals(m.length, 3);
  assertEquals(m[0].payload, 8);
  assert(m[0].lang);
  assert(m[0].version);
  csv(m[0]);
}

function csv(m: Metric) {
  assertEquals(Metric.header().split(",").length, 9);
  const lines = m.toCsv().split("\n");
  assertEquals(lines.length, 2);

  const fields = lines[0].split(",");
  assertEquals(fields.length, 9);
}

Deno.test("bench - no opts toss", async () => {
  const nc = await connect({ servers: u });
  assertThrows(
    () => {
      new Bench(nc, {});
    },
    Error,
    "no options selected",
  );

  await nc.close();
});

Deno.test(`bench - pubsub`, async () => {
  const m = await runBench({
    pub: true,
    sub: true,
    msgs: 5,
    size: 8,
    callbacks: true,
    subject: createInbox(),
  });
  pubSub(m);
});

Deno.test(`bench - pubsub async`, async () => {
  const m = await runBench({
    pub: true,
    sub: true,
    msgs: 5,
    size: 8,
    subject: createInbox(),
  });
  pubSub(m);
});

Deno.test(`bench - req`, async () => {
  const m = await runBench({
    req: true,
    rep: true,
    callbacks: true,
    msgs: 5,
    size: 8,
    subject: createInbox(),
  });
  reqRep(m);
});

Deno.test(`bench - req async`, async () => {
  const m = await runBench({
    req: true,
    rep: true,
    asyncRequests: true,
    callbacks: true,
    msgs: 5,
    size: 8,
    subject: createInbox(),
  });
  reqRep(m);
});
