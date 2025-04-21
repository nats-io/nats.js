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
import { connect, NatsServer } from "test_helpers";

import { initStream } from "./jstest_util.ts";
import {
  AckPolicy,
  jetstream,
  type JetStreamClient,
  type JetStreamManager,
  jetstreamManager,
  JsHeaders,
  RepublishHeaders,
  RetentionPolicy,
  StorageType,
} from "../src/mod.ts";

import type { Advisory } from "../src/mod.ts";
import {
  deferred,
  delay,
  Empty,
  headers,
  nanos,
  NoRespondersError,
  nuid,
  RequestError,
} from "@nats-io/nats-core";
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertExists,
  assertInstanceOf,
  assertIsError,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert";

import { JetStreamClientImpl, JetStreamManagerImpl } from "../src/jsclient.ts";
import {
  type BaseApiClientImpl,
  defaultJsOptions,
} from "../src/jsbaseclient_api.ts";
import {
  cleanup,
  flakyTest,
  jetstreamServerConf,
  notCompatible,
  setup,
} from "test_helpers";
import { PubHeaders } from "../src/jsapi_types.ts";
import { JetStreamApiError, JetStreamNotEnabled } from "../src/jserrors.ts";
import { assertBetween } from "../../test_helpers/mod.ts";

Deno.test("jetstream - default options", () => {
  const opts = defaultJsOptions();
  assertEquals(opts, { apiPrefix: "$JS.API", timeout: 5000 });
});

Deno.test("jetstream - default override timeout", () => {
  const opts = defaultJsOptions({ timeout: 1000 });
  assertEquals(opts, { apiPrefix: "$JS.API", timeout: 1000 });
});

Deno.test("jetstream - default override prefix", () => {
  const opts = defaultJsOptions({ apiPrefix: "$XX.API" });
  assertEquals(opts, { apiPrefix: "$XX.API", timeout: 5000 });
});

Deno.test("jetstream - options rejects empty prefix", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  assertThrows(() => {
    jetstream(nc, { apiPrefix: "" });
  });
  await cleanup(ns, nc);
});

Deno.test("jetstream - options removes trailing dot", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc, { apiPrefix: "hello." }) as JetStreamClientImpl;
  assertEquals(js.opts.apiPrefix, "hello");
  await cleanup(ns, nc);
});

Deno.test("jetstream - find stream throws when not found", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc) as JetStreamClientImpl;
  await assertRejects(
    async () => {
      await js.findStream("hello");
    },
    Error,
    "no stream matches subject",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish basic", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const js = jetstream(nc);
  let pa = await js.publish(subj);
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 1);

  pa = await js.publish(subj);
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 2);

  await cleanup(ns, nc);
});

Deno.test("jetstream - ackAck", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = jetstream(nc);
  await js.publish(subj);

  const c = await js.consumers.get(stream, "me");

  const ms = await c.next();
  assertExists(ms);
  assertEquals(await ms.ackAck(), true);
  assertEquals(await ms.ackAck(), false);
  await cleanup(ns, nc);
});

Deno.test("jetstream - publish id", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const js = jetstream(nc);
  const pa = await js.publish(subj, Empty, { msgID: "a" });
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 1);

  const jsm = await jetstreamManager(nc);
  const sm = await jsm.streams.getMessage(stream, { seq: 1 });
  assertEquals(sm?.header.get(PubHeaders.MsgIdHdr), "a");

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish require stream", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const js = jetstream(nc);
  await assertRejects(
    async () => {
      await js.publish(subj, Empty, { expect: { streamName: "xxx" } });
    },
    Error,
    "expected stream does not match",
    undefined,
  );

  const pa = await js.publish(subj, Empty, { expect: { streamName: stream } });
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish require last message id", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const js = jetstream(nc);
  let pa = await js.publish(subj, Empty, { msgID: "a" });
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 1);

  await assertRejects(
    async () => {
      await js.publish(subj, Empty, { msgID: "b", expect: { lastMsgID: "b" } });
    },
    Error,
    "wrong last msg ID: a",
    undefined,
  );

  pa = await js.publish(subj, Empty, {
    msgID: "b",
    expect: { lastMsgID: "a" },
  });
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 2);

  await cleanup(ns, nc);
});

Deno.test("jetstream - get message last by subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  await jsm.streams.add({ name: stream, subjects: [`${stream}.*`] });

  const js = jetstream(nc);
  await js.publish(`${stream}.A`, "a");
  await js.publish(`${stream}.A`, "aa");
  await js.publish(`${stream}.B`, "b");
  await js.publish(`${stream}.B`, "bb");

  const sm = await jsm.streams.getMessage(stream, {
    last_by_subj: `${stream}.A`,
  });
  assertEquals(sm?.string(), "aa");

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish first sequence", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { subj } = await initStream(nc);

  const js = jetstream(nc);
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await assertRejects(
    async () => {
      await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
    },
    Error,
    "wrong last sequence",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish require last sequence", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const js = jetstream(nc);
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });

  await assertRejects(
    async () => {
      await js.publish(subj, Empty, {
        msgID: "b",
        expect: { lastSequence: 2 },
      });
    },
    Error,
    "wrong last sequence: 1",
    undefined,
  );

  const pa = await js.publish(subj, Empty, {
    msgID: "b",
    expect: { lastSequence: 1 },
  });
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 2);

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish require last sequence by subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  await jsm.streams.add({ name: stream, subjects: [`${stream}.*`] });

  const js = jetstream(nc);

  await js.publish(`${stream}.A`, Empty);
  await js.publish(`${stream}.B`, Empty);
  const pa = await js.publish(`${stream}.A`, Empty, {
    expect: { lastSubjectSequence: 1 },
  });
  for (let i = 0; i < 100; i++) {
    await js.publish(`${stream}.B`, Empty);
  }
  // this will only succeed if the last recording sequence for the subject matches
  await js.publish(`${stream}.A`, Empty, {
    expect: { lastSubjectSequence: pa.seq },
  });

  await cleanup(ns, nc);
});

Deno.test("jetstream - ephemeral options", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  const v = await jsm.consumers.add(stream, {
    inactive_threshold: nanos(1000),
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(v.config.inactive_threshold, nanos(1000));
  await cleanup(ns, nc);
});

Deno.test("jetstream - publish headers", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const js = jetstream(nc);
  const h = headers();
  h.set("a", "b");

  await js.publish(subj, Empty, { headers: h });

  const c = await js.consumers.get(stream);

  const ms = await c.next();
  assertExists(ms);
  ms.ack();
  assertEquals(ms.headers!.get("a"), "b");
  await cleanup(ns, nc);
});

Deno.test("jetstream - JSON", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const js = jetstream(nc);
  const values = [null, true, "", ["hello"], { hello: "world" }];
  for (const v of values) {
    await js.publish(subj, JSON.stringify(v));
  }

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const c = await js.consumers.get(stream, "me");
  for (let v of values) {
    const m = await c.next();
    assertExists(m);
    m.ack();
    // JSON doesn't serialize undefines, but if passed to the encoder
    // it becomes a null
    if (v === undefined) {
      v = null;
    }
    assertEquals(m.json(), v);
  }
  await cleanup(ns, nc);
});

Deno.test("jetstream - domain", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        domain: "afton",
      },
    }),
  );

  const jsm = await jetstreamManager(nc, { domain: "afton" });
  const ai = await jsm.getAccountInfo();
  assert(ai.domain, "afton");
  //@ts-ignore: internal use
  assertEquals(jsm.prefix, `$JS.afton.API`);
  await cleanup(ns, nc);
});

Deno.test("jetstream - account domain", async () => {
  const conf = jetstreamServerConf({
    jetstream: {
      domain: "A",
    },
    accounts: {
      A: {
        users: [
          { user: "a", password: "a" },
        ],
        jetstream: { max_memory: 10000, max_file: 10000 },
      },
    },
  });

  const { ns, nc } = await setup(conf, { user: "a", pass: "a" });

  const jsm = await jetstreamManager(nc, { domain: "A" });
  const ai = await jsm.getAccountInfo();
  assert(ai.domain, "A");
  //@ts-ignore: internal use
  assertEquals(jsm.prefix, `$JS.A.API`);
  await cleanup(ns, nc);
});

Deno.test("jetstream - puback domain", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        domain: "A",
      },
    }),
  );

  if (await notCompatible(ns, nc, "2.3.5")) {
    return;
  }

  const { subj } = await initStream(nc);
  const js = jetstream(nc);
  const pa = await js.publish(subj);
  assertEquals(pa.domain, "A");
  await cleanup(ns, nc);
});

Deno.test("jetstream - source", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const stream = nuid.next();
  const subj = `${stream}.*`;
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add(
    { name: stream, subjects: [subj] },
  );

  const js = jetstream(nc);

  for (let i = 0; i < 10; i++) {
    await js.publish(`${stream}.A`);
    await js.publish(`${stream}.B`);
  }

  await jsm.streams.add({
    name: "work",
    storage: StorageType.File,
    retention: RetentionPolicy.Workqueue,
    sources: [
      { name: stream, filter_subject: ">" },
    ],
  });

  // source will not process right away?
  await delay(1000);

  await jsm.consumers.add("work", {
    ack_policy: AckPolicy.Explicit,
    durable_name: "worker",
    filter_subject: `${stream}.B`,
  });

  const c = await js.consumers.get("work", "worker");
  const iter = await c.fetch({ max_messages: 10 });
  for await (const m of iter) {
    m.ack();
  }
  await nc.flush();

  const si = await jsm.streams.info("work");
  // stream still has all the 'A' messages
  assertEquals(si.state.messages, 10);

  await cleanup(ns, nc);
});

Deno.test("jetstream - seal", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.2")) {
    return;
  }
  const { stream, subj } = await initStream(nc);
  const js = jetstream(nc);
  await js.publish(subj, "hello");
  await js.publish(subj, "second");

  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.info(stream);
  assertEquals(si.config.sealed, false);
  assertEquals(si.config.deny_purge, false);
  assertEquals(si.config.deny_delete, false);

  await jsm.streams.deleteMessage(stream, 1);

  si.config.sealed = true;
  const usi = await jsm.streams.update(stream, si.config);
  assertEquals(usi.config.sealed, true);

  await assertRejects(
    async () => {
      await jsm.streams.deleteMessage(stream, 2);
    },
    Error,
    "invalid operation on sealed stream",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - deny delete", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.2")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
    deny_delete: true,
  });

  const js = jetstream(nc);
  await js.publish(subj, "hello");
  await js.publish(subj, "second");

  const si = await jsm.streams.info(stream);
  assertEquals(si.config.deny_delete, true);

  await assertRejects(
    async () => {
      await jsm.streams.deleteMessage(stream, 1);
    },
    Error,
    "message delete not permitted",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - deny purge", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.2")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
    deny_purge: true,
  });

  const js = jetstream(nc);
  await js.publish(subj, "hello");
  await js.publish(subj, "second");

  const si = await jsm.streams.info(stream);
  assertEquals(si.config.deny_purge, true);

  await assertRejects(
    async () => {
      await jsm.streams.purge(stream);
    },
    Error,
    "stream purge not permitted",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - rollup all", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
    allow_rollup_hdrs: true,
  });

  const js = jetstream(nc);
  const buf = [];
  for (let i = 1; i < 11; i++) {
    buf.push(js.publish(`${stream}.A`, JSON.stringify({ value: i })));
  }
  await Promise.all(buf);

  const h = headers();
  h.set(JsHeaders.RollupHdr, JsHeaders.RollupValueAll);
  await js.publish(`${stream}.summary`, JSON.stringify({ value: 42 }), {
    headers: h,
  });

  const si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - rollup subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const stream = "S";
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
    allow_rollup_hdrs: true,
  });

  const js = jetstream(nc);
  const buf = [];
  for (let i = 1; i < 11; i++) {
    buf.push(js.publish(`${stream}.A`, JSON.stringify({ value: i })));
    buf.push(js.publish(`${stream}.B`, JSON.stringify({ value: i })));
  }
  await Promise.all(buf);

  let si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 20);

  let cia = await jsm.consumers.add(stream, {
    durable_name: "dura",
    filter_subject: `${stream}.A`,
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(cia.num_pending, 10);

  const h = headers();
  h.set(JsHeaders.RollupHdr, JsHeaders.RollupValueSubject);
  await js.publish(`${stream}.A`, JSON.stringify({ value: 0 }), {
    headers: h,
  });

  await delay(5000);

  cia = await jsm.consumers.info(stream, "dura");
  assertEquals(cia.num_pending, 1);

  si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 11);

  const cib = await jsm.consumers.add(stream, {
    durable_name: "durb",
    filter_subject: `${stream}.B`,
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(cib.num_pending, 10);
  await cleanup(ns, nc);
});

Deno.test("jetstream - no rollup", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const stream = "S";
  const subj = `${stream}.*`;
  const si = await jsm.streams.add({
    name: stream,
    subjects: [subj],
    allow_rollup_hdrs: false,
  });
  assertEquals(si.config.allow_rollup_hdrs, false);

  const js = jetstream(nc);
  const buf = [];
  for (let i = 1; i < 11; i++) {
    buf.push(js.publish(`${stream}.A`, JSON.stringify({ value: i })));
  }
  await Promise.all(buf);

  const h = headers();
  h.set(JsHeaders.RollupHdr, JsHeaders.RollupValueSubject);
  await assertRejects(
    async () => {
      await js.publish(`${stream}.A`, JSON.stringify({ value: 42 }), {
        headers: h,
      });
    },
    Error,
    "rollup not permitted",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - backoff", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.7.2")) {
    return;
  }

  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  const ms = [250, 1000, 3000];
  const backoff = ms.map((n) => nanos(n));
  const ci = await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    max_deliver: 4,
    backoff,
  });

  assert(ci.config.backoff);
  assertEquals(ci.config.backoff[0], backoff[0]);
  assertEquals(ci.config.backoff[1], backoff[1]);
  assertEquals(ci.config.backoff[2], backoff[2]);

  const js = jetstream(nc);
  await js.publish(subj);

  const when: number[] = [];
  const c = await js.consumers.get(stream, "me");
  const iter = await c.consume({
    callback: (m) => {
      when.push(Date.now());
      if (m.info.deliveryCount === 4) {
        iter.stop();
      }
    },
  });

  await iter.closed();

  const offset = when.map((n, idx) => {
    const p = idx > 0 ? idx - 1 : 0;
    return n - when[p];
  });

  offset.slice(1).forEach((n, idx) => {
    assertAlmostEquals(n, ms[idx], 50);
  });

  await cleanup(ns, nc);
});

Deno.test("jetstream - redelivery", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.7.2")) {
    return;
  }

  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  const ci = await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    max_deliver: 4,
    ack_wait: nanos(1000),
  });

  assertEquals(ci.config.max_deliver, 4);

  const js = jetstream(nc);
  await js.publish(subj);

  const c = await js.consumers.get(stream, "me");

  let redeliveries = 0;
  const iter = await c.consume({
    callback: (m) => {
      if (m.redelivered) {
        redeliveries++;
      }
      if (m.info.deliveryCount === 4) {
        setTimeout(() => {
          iter.stop();
        }, 2000);
      }
    },
  });

  await iter.closed();
  assertEquals(redeliveries, 3);

  await cleanup(ns, nc);
});

Deno.test("jetstream - detailed errors", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);

  const ne = await assertRejects(() => {
    return jsm.streams.add({
      name: "test",
      num_replicas: 3,
      subjects: ["foo"],
    });
  }, JetStreamApiError);

  assertEquals(ne.message, "replicas > 1 not supported in non-clustered mode");
  assertEquals(ne.code, 10074);
  assertEquals(ne.status, 500);

  await cleanup(ns, nc);
});

Deno.test(
  "jetstream - repub on 503",
  flakyTest(async () => {
    const servers = await NatsServer.setupDataConnCluster(4);
    const nc = await connect({ port: servers[0].port });

    const { stream, subj } = await initStream(nc, nuid.next(), {
      num_replicas: 3,
    });

    const jsm = await jetstreamManager(nc);
    const si = await jsm.streams.info(stream);
    const host = si.cluster!.leader || "";
    const leader = servers.find((s) => {
      return s.config.server_name === host;
    });

    // publish a message
    const js = jetstream(nc);
    const pa = await js.publish(subj);
    assertEquals(pa.stream, stream);

    // now stop and wait a bit for the servers
    await leader?.stop();
    await delay(1000);

    await js.publish(subj, Empty, {
      retries: 15,
      timeout: 15000,
    });

    await nc.close();
    await NatsServer.stopAll(servers, true);
  }),
);

Deno.test("jetstream - duplicate message pub", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { subj } = await initStream(nc);
  const js = jetstream(nc);

  let ack = await js.publish(subj, Empty, { msgID: "x" });
  assertEquals(ack.duplicate, false);

  ack = await js.publish(subj, Empty, { msgID: "x" });
  assertEquals(ack.duplicate, true);

  await cleanup(ns, nc);
});

Deno.test("jetstream - republish", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.add({
    name: nuid.next(),
    subjects: ["foo"],
    republish: {
      src: "foo",
      dest: "bar",
    },
  });

  assertEquals(si.config.republish?.src, "foo");
  assertEquals(si.config.republish?.dest, "bar");

  const sub = nc.subscribe("bar", { max: 1 });
  const done = (async () => {
    for await (const m of sub) {
      assertEquals(m.subject, "bar");
      assert(m.headers?.get(RepublishHeaders.Subject), "foo");
      assert(m.headers?.get(RepublishHeaders.Sequence), "1");
      assert(m.headers?.get(RepublishHeaders.Stream), si.config.name);
      assert(m.headers?.get(RepublishHeaders.LastSequence), "0");
    }
  })();

  nc.publish("foo");
  await done;

  await cleanup(ns, nc);
});

Deno.test("jetstream - num_replicas consumer option", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  const name = nuid.next();

  // will reject with a replica error (replica value was properly sent)
  await assertRejects(
    () => {
      return jsm.streams.add({
        name,
        subjects: ["foo"],
        num_replicas: 3,
      });
    },
    Error,
    "replicas > 1 not supported in non-clustered mode",
  );

  // replica of 1
  const si = await jsm.streams.add({
    name,
    subjects: ["foo"],
  });
  assertEquals(si.config.num_replicas, 1);

  // will reject since the replicas are not enabled - so it was read
  await assertRejects(
    () => {
      return jsm.consumers.add(name, {
        name,
        ack_policy: AckPolicy.Explicit,
        num_replicas: 3,
      });
    },
    Error,
    "replicas > 1 not supported in non-clustered mode",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - filter_subject consumer update", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.add({ name: nuid.next(), subjects: ["foo.>"] });
  let ci = await jsm.consumers.add(si.config.name, {
    ack_policy: AckPolicy.Explicit,
    filter_subject: "foo.bar",
    durable_name: "a",
  });
  assertEquals(ci.config.filter_subject, "foo.bar");

  ci.config.filter_subject = "foo.baz";
  ci = await jsm.consumers.update(si.config.name, "a", ci.config);
  assertEquals(ci.config.filter_subject, "foo.baz");
  await cleanup(ns, nc);
});

Deno.test("jetstream - jsmsg decode", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await jsm.streams.add({ name, subjects: [`a.>`] });

  await jsm.consumers.add(name, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  await js.publish("a.a", "hello");
  await js.publish("a.a", JSON.stringify({ one: "two", a: [1, 2, 3] }));

  const c = await js.consumers.get(name, "me");
  assertEquals((await c.next())?.string(), "hello");
  assertEquals((await c.next())?.json(), {
    one: "two",
    a: [1, 2, 3],
  });

  await cleanup(ns, nc);
});

Deno.test("jetstream - input transform", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const name = nuid.next();
  const jsm = await jetstreamManager(nc);

  const si = await jsm.streams.add({
    name,
    subjects: ["foo"],
    subject_transform: {
      src: ">",
      dest: "transformed.>",
    },
    storage: StorageType.Memory,
  });

  assertEquals(si.config.subject_transform, {
    src: ">",
    dest: "transformed.>",
  });

  const js = jetstream(nc);
  const pa = await js.publish("foo", Empty);
  assertEquals(pa.seq, 1);

  const m = await jsm.streams.getMessage(si.config.name, { seq: 1 });
  assertEquals(m?.subject, "transformed.foo");

  await cleanup(ns, nc);
});

Deno.test("jetstream - source transforms", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);

  const proms = ["foo", "bar", "baz"].map((subj) => {
    return jsm.streams.add({
      name: subj,
      subjects: [subj],
      storage: StorageType.Memory,
    });
  });
  await Promise.all(proms);

  const js = jetstream(nc);
  await Promise.all([
    js.publish("foo", Empty),
    js.publish("bar", Empty),
    js.publish("baz", Empty),
  ]);

  await jsm.streams.add({
    name: "sourced",
    storage: StorageType.Memory,
    sources: [
      { name: "foo", subject_transforms: [{ src: ">", dest: "foo2.>" }] },
      { name: "bar" },
      { name: "baz" },
    ],
  });

  while (true) {
    const si = await jsm.streams.info("sourced");
    if (si.state.messages === 3) {
      break;
    }
    await delay(100);
  }

  const map = new Map<string, string>();
  const oc = await js.consumers.get("sourced");
  const iter = await oc.fetch({ max_messages: 3 });
  for await (const m of iter) {
    map.set(m.subject, m.subject);
  }

  assert(map.has("foo2.foo"));
  assert(map.has("bar"));
  assert(map.has("baz"));

  await cleanup(ns, nc);
});

Deno.test("jetstream - term reason", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "foos",
    subjects: ["foo.*"],
  });

  const js = jetstream(nc);

  await Promise.all(
    [
      js.publish("foo.1"),
      js.publish("foo.2"),
      js.publish("foo.term"),
    ],
  );

  await jsm.consumers.add("foos", {
    name: "bar",
    ack_policy: AckPolicy.Explicit,
  });

  const termed = deferred<Advisory>();
  const advisories = jsm.advisories();
  (async () => {
    for await (const a of advisories) {
      if (a.kind === "terminated") {
        termed.resolve(a);
        break;
      }
    }
  })().catch((err) => {
    console.log(err);
  });

  const c = await js.consumers.get("foos", "bar");
  const iter = await c.consume();
  await (async () => {
    for await (const m of iter) {
      if (m.subject.endsWith(".term")) {
        m.term("requested termination");
        break;
      } else {
        m.ack();
      }
    }
  })().catch();

  const s = await termed;
  const d = s.data as Record<string, unknown>;
  assertEquals(d.type, "io.nats.jetstream.advisory.v1.terminated");
  assertEquals(d.reason, "requested termination");

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish no responder", async (t) => {
  await t.step("not a jetstream server", async () => {
    const { ns, nc } = await setup();
    const js = jetstream(nc);
    const err = await assertRejects(
      () => {
        return js.publish("hello");
      },
      JetStreamNotEnabled,
    );

    assertInstanceOf(err.cause, RequestError);
    assertInstanceOf(err.cause?.cause, NoRespondersError);

    await cleanup(ns, nc);
  });

  await t.step("jetstream not listening for subject", async () => {
    const { ns, nc } = await setup(jetstreamServerConf());
    const jsm = await jetstreamManager(nc);
    await jsm.streams.add({ name: "s", subjects: ["a", "b"] });
    const js = jetstream(nc);
    const err = await assertRejects(
      () => {
        return js.publish("c");
      },
      JetStreamNotEnabled,
    );

    assertInstanceOf(err.cause, RequestError);
    assertInstanceOf(err.cause?.cause, NoRespondersError);

    await cleanup(ns, nc);
  });
});

Deno.test("jetstream - base client timeout", async () => {
  const { ns, nc } = await setup();

  nc.subscribe("test", { callback: () => {} });

  async function pub(c: JetStreamClient): Promise<number> {
    const start = Date.now();
    try {
      await c.publish("test", Empty);
    } catch (err) {
      assertIsError(err, Error, "timeout");
      return Date.now() - start;
    }
    throw new Error("should have failed");
  }

  async function req(c: JetStreamClient): Promise<number> {
    const start = Date.now();
    try {
      await (c as unknown as BaseApiClientImpl)._request("test", Empty);
    } catch (err) {
      assertIsError(err, Error, "timeout");
      return Date.now() - start;
    }
    throw new Error("should have failed");
  }

  let c = new JetStreamClientImpl(nc) as JetStreamClient;
  assertBetween(await pub(c), 4900, 5100);
  assertBetween(await req(c), 4900, 5100);

  c = jetstream(nc);
  assertBetween(await pub(c), 4900, 5100);
  assertBetween(await req(c), 4900, 5100);

  c = new JetStreamClientImpl(nc, { timeout: 500 }) as JetStreamClient;
  assertBetween(await pub(c), 450, 600);
  assertBetween(await req(c), 450, 600);

  c = jetstream(nc, { timeout: 500 });
  assertBetween(await pub(c), 450, 600);
  assertBetween(await req(c), 450, 600);

  await cleanup(ns, nc);
});

Deno.test("jetstream - jsm base timeout", async () => {
  const { ns, nc } = await setup();

  nc.subscribe("test", { callback: () => {} });

  async function req(c: JetStreamManager): Promise<number> {
    const start = Date.now();
    try {
      await (c as unknown as BaseApiClientImpl)._request("test", Empty);
    } catch (err) {
      assertIsError(err, Error, "timeout");
      return Date.now() - start;
    }
    throw new Error("should have failed");
  }

  let c = new JetStreamManagerImpl(nc) as JetStreamManager;
  assertBetween(await req(c), 4900, 5100);

  c = await jetstreamManager(nc, { checkAPI: false });
  assertBetween(await req(c), 4900, 5100);

  c = new JetStreamManagerImpl(nc, { timeout: 500 }) as JetStreamManager;
  assertBetween(await req(c), 450, 600);

  c = await jetstreamManager(nc, { timeout: 500, checkAPI: false });
  assertBetween(await req(c), 450, 600);

  await cleanup(ns, nc);
});
