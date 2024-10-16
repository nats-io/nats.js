/*
 * Copyright 2021-2023 The NATS Authors
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
  _setup,
  cleanup,
  connect,
  jetstreamExportServerConf,
  jetstreamServerConf,
} from "test_helpers";
import { initStream } from "./jstest_util.ts";
import { AckPolicy, DeliverPolicy } from "../src/jsapi_types.ts";
import type { ConsumerConfig } from "../src/jsapi_types.ts";
import { assertEquals, assertExists } from "jsr:@std/assert";
import { Empty, nanos, nuid } from "@nats-io/nats-core";

import { consumerOpts } from "../src/types.ts";
import type { ConsumerOptsBuilderImpl } from "../src/types.ts";

import { jetstream, jetstreamManager } from "../src/mod.ts";

Deno.test("jetstream - pull consumer options", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  const v = await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    max_batch: 10,
    max_expires: nanos(20000),
  });

  assertEquals(v.config.max_batch, 10);
  assertEquals(v.config.max_expires, nanos(20000));

  await cleanup(ns, nc);
});

Deno.test("jetstream - cross account pull", async () => {
  const { ns, nc: admin } = await _setup(connect, jetstreamExportServerConf(), {
    user: "js",
    pass: "js",
  });

  // add a stream
  const { stream, subj } = await initStream(admin);
  const admjs = jetstream(admin);
  await admjs.publish(subj);
  await admjs.publish(subj);

  const admjsm = await jetstreamManager(admin);

  // create a durable config
  const bo = consumerOpts() as ConsumerOptsBuilderImpl;
  bo.manualAck();
  bo.ackExplicit();
  bo.durable("me");
  const opts = bo.getOpts();
  await admjsm.consumers.add(stream, opts.config);

  const nc = await connect({
    port: ns.port,
    user: "a",
    pass: "s3cret",
    inboxPrefix: "A",
  });

  // the api prefix is not used for pull/fetch()
  const js = jetstream(nc, { apiPrefix: "IPA" });
  const c = await js.consumers.get(stream, "me");
  let msg = await c.next();
  assertExists(msg);
  assertEquals(msg.seq, 1);
  msg = await c.next();
  assertExists(msg);
  assertEquals(msg.seq, 2);
  msg = await c.next({ expires: 1000 });
  assertEquals(msg, null);

  await cleanup(ns, admin, nc);
});

Deno.test("jetstream - last of", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const n = nuid.next();
  await jsm.streams.add({
    name: n,
    subjects: [`${n}.>`],
  });

  const subja = `${n}.A`;
  const subjb = `${n}.B`;

  const js = jetstream(nc);

  await js.publish(subja, Empty);
  await js.publish(subjb, Empty);
  await js.publish(subjb, Empty);
  await js.publish(subja, Empty);

  const opts = {
    durable_name: "B",
    filter_subject: subjb,
    deliver_policy: DeliverPolicy.Last,
    ack_policy: AckPolicy.Explicit,
  } as Partial<ConsumerConfig>;

  await jsm.consumers.add(n, opts);
  const c = await js.consumers.get(n, "B");
  const m = await c.next();
  assertExists(m);
  assertEquals(m.seq, 3);

  await cleanup(ns, nc);
});
