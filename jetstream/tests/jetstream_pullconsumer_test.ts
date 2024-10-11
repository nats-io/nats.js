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
  disabled,
  jetstreamExportServerConf,
  jetstreamServerConf,
  notCompatible,
} from "test_helpers";
import { initStream } from "./jstest_util.ts";
import { AckPolicy, DeliverPolicy, StorageType } from "../src/jsapi_types.ts";
import type { ConsumerConfig } from "../src/jsapi_types.ts";
import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
  fail,
} from "jsr:@std/assert";
import { checkJsError } from "../src/jsutil.ts";
import {
  DebugEvents,
  deferred,
  delay,
  Empty,
  ErrorCode,
  Events,
  JSONCodec,
  nanos,
  nuid,
  StringCodec,
  syncIterator,
} from "@nats-io/nats-core";

import type {
  NatsConnectionImpl,
  NatsError,
} from "@nats-io/nats-core/internal";

import { consumerOpts } from "../src/types.ts";
import type {
  ConsumerOptsBuilderImpl,
  JetStreamSubscriptionInfoable,
  PubAck,
} from "../src/types.ts";

import type { JsMsg } from "../src/jsmsg.ts";
import type { JetStreamClientImpl } from "../src/jsclient.ts";
import { callbackConsume } from "./jetstream_test.ts";
import { jetstream, jetstreamManager } from "../src/mod.ts";

Deno.test("jetstream - pull no messages", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = jetstream(nc);
  await assertRejects(
    async () => {
      await js.pull(stream, "me");
    },
    Error,
    "no messages",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = jetstream(nc);
  await js.publish(subj, Empty, { msgID: "a" });
  let ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 1);

  const jm = await js.pull(stream, "me");
  jm.ack();
  await nc.flush();
  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 1);
  assertEquals(ci.ack_floor.stream_seq, 1, JSON.stringify(ci));

  await cleanup(ns, nc);
});

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

Deno.test("jetstream - pull sub - attached iterator", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const jc = JSONCodec<number>();

  let sum = 0;
  const opts = consumerOpts();
  opts.durable("me");

  const js = jetstream(nc);
  const sub = await js.pullSubscribe(subj, opts);
  (async () => {
    for await (const msg of sub) {
      assert(msg);
      //@ts-ignore: test
      const ne = checkJsError(msg.msg);
      if (ne) {
        console.log(ne.message);
      }
      const n = jc.decode(msg.data);
      sum += n;
      msg.ack();
    }
  })().then();
  sub.pull({ expires: 500, batch: 5 });

  const subin = sub as unknown as JetStreamSubscriptionInfoable;
  assert(subin.info);
  assertEquals(subin.info.attached, true);
  await delay(250);
  assertEquals(sum, 0);

  let ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 0);
  assertEquals(ci.ack_floor.stream_seq, 0);

  await js.publish(subj, jc.encode(1), { msgID: "1" });
  await js.publish(subj, jc.encode(2), { msgID: "2" });
  sub.pull({ expires: 500, batch: 5 });
  await delay(500);
  assertEquals(sum, 3);

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 2);
  assertEquals(ci.ack_floor.stream_seq, 2);

  await js.publish(subj, jc.encode(3), { msgID: "3" });
  await js.publish(subj, jc.encode(5), { msgID: "4" });
  sub.pull({ expires: 500, batch: 5 });
  await delay(1000);
  assertEquals(sum, 11);

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 4);
  assertEquals(ci.ack_floor.stream_seq, 4);

  await js.publish(subj, jc.encode(7), { msgID: "5" });

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub - attached callback", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const jc = JSONCodec<number>();

  let sum = 0;
  const opts = consumerOpts();
  opts.durable("me");

  opts.callback((err, msg) => {
    if (err) {
      switch (err.code) {
        case ErrorCode.JetStream408RequestTimeout:
        case ErrorCode.JetStream409:
        case ErrorCode.JetStream404NoMessages:
          return;
        default:
          fail(err.code);
      }
    }
    if (msg) {
      const n = jc.decode(msg.data);
      sum += n;
      msg.ack();
    }
  });

  const js = jetstream(nc);
  const sub = await js.pullSubscribe(subj, opts);
  sub.pull({ expires: 500, batch: 5 });
  const subin = sub as unknown as JetStreamSubscriptionInfoable;
  assert(subin.info);
  assertEquals(subin.info.attached, true);
  await delay(250);
  assertEquals(sum, 0);

  let ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 0);
  assertEquals(ci.ack_floor.stream_seq, 0);

  await js.publish(subj, jc.encode(1), { msgID: "1" });
  await js.publish(subj, jc.encode(2), { msgID: "2" });
  sub.pull({ expires: 500, batch: 5 });
  await delay(500);
  assertEquals(sum, 3);

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 2);
  assertEquals(ci.ack_floor.stream_seq, 2);

  await js.publish(subj, jc.encode(3), { msgID: "3" });
  await js.publish(subj, jc.encode(5), { msgID: "4" });
  sub.pull({ expires: 500, batch: 5 });
  await delay(1000);
  assertEquals(sum, 11);

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 4);
  assertEquals(ci.ack_floor.stream_seq, 4);

  await js.publish(subj, jc.encode(7), { msgID: "5" });

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub - not attached callback", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const js = jetstream(nc);
  await js.publish(subj);

  const opts = consumerOpts();
  opts.durable("me");
  opts.ackExplicit();
  opts.maxMessages(1);
  opts.callback(callbackConsume(false));

  const sub = await js.pullSubscribe(subj, opts);
  sub.pull();
  const subin = sub as unknown as JetStreamSubscriptionInfoable;
  assert(subin.info);
  assertEquals(subin.info.attached, false);
  await sub.closed;

  const jsm = await jetstreamManager(nc);
  const ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 1);
  assertEquals(ci.ack_floor.stream_seq, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub requires explicit", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { subj } = await initStream(nc);

  const js = jetstream(nc);

  await assertRejects(
    async () => {
      const opts = consumerOpts();
      opts.durable("me");
      opts.ackAll();
      await js.pullSubscribe(subj, opts);
    },
    Error,
    "ack policy for pull",
    undefined,
  );
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub ephemeral", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { subj } = await initStream(nc);

  const js = jetstream(nc);
  await js.publish(subj);

  const d = deferred<JsMsg>();
  const opts = consumerOpts();

  opts.ackExplicit();
  opts.callback((err, msg) => {
    if (err) {
      d.reject(err);
    } else {
      d.resolve(msg!);
    }
  });

  const ps = await js.pullSubscribe(subj, opts);
  ps.pull({ no_wait: true });
  const r = await d;
  assertEquals(r.subject, subj);
  await cleanup(ns, nc);
});

Deno.test("jetstream - push requires delivery_subject", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  const js = jsm.jetstream();

  await jsm.consumers.add(stream, {
    durable_name: "pull",
    ack_policy: AckPolicy.Explicit,
  });

  await jsm.consumers.add(stream, {
    durable_name: "push",
    ack_policy: AckPolicy.Explicit,
    deliver_subject: "foo",
  });

  await assertRejects(
    () => {
      return js.consumers.get(stream, "push");
    },
    Error,
    "not a pull consumer",
  );

  await assertRejects(
    () => {
      return js.consumers.getPushConsumer(stream, "pull");
    },
    Error,
    "not a push consumer",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - cross account pull subscribe", () => {
  disabled("cross account pull subscribe test needs updating");
  // const { ns, nc: admin } = await _setup(connect,
  //   jetstreamExportServerConf(),
  //   {
  //     user: "js",
  //     pass: "js",
  //   },
  // );
  //
  // // add a stream
  // const { stream, subj } = await initStream(admin);
  // const adminjs = admin.jetstream();
  // await adminjs.publish(subj);
  // await adminjs.publish(subj);
  //
  // // FIXME: create a durable config
  // const bo = consumerOpts() as ConsumerOptsBuilderImpl;
  // bo.manualAck();
  // bo.ackExplicit();
  // bo.maxMessages(2);
  // bo.durable("me");
  //
  // // pull subscriber stalls
  // const nc = await connect({
  //   port: ns.port,
  //   user: "a",
  //   pass: "s3cret",
  //   inboxPrefix: "A",
  // });
  // const js = nc.jetstream({ apiPrefix: "IPA" });
  //
  // const opts = bo.getOpts();
  // const sub = await js.pullSubscribe(subj, opts);
  // const done = (async () => {
  //   for await (const m of sub) {
  //     m.ack();
  //   }
  // })();
  // sub.pull({ batch: 2 });
  // await done;
  // assertEquals(sub.getProcessed(), 2);
  //
  // const ci = await sub.consumerInfo();
  // assertEquals(ci.num_pending, 0);
  // assertEquals(ci.delivered.stream_seq, 2);
  //
  // await sub.destroy();
  // await assertThrowsAsync(
  //   async () => {
  //     await sub.consumerInfo();
  //   },
  //   Error,
  //   "consumer not found",
  // );
  //
  // await cleanup(ns, admin, nc);
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
  let msg = await js.pull(stream, "me");
  assertEquals(msg.seq, 1);
  msg = await js.pull(stream, "me");
  assertEquals(msg.seq, 2);
  await assertRejects(
    async () => {
      await js.pull(stream, "me");
    },
    Error,
    "no messages",
    undefined,
  );

  await cleanup(ns, admin, nc);
});

Deno.test("jetstream - pull stream doesn't exist", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const js = jetstream(nc, { timeout: 1000 });
  await assertRejects(
    async () => {
      await js.pull("helloworld", "me");
    },
    Error,
    ErrorCode.Timeout,
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull consumer doesn't exist", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const { stream } = await initStream(nc);
  const js = jetstream(nc, { timeout: 1000 });
  await assertRejects(
    async () => {
      await js.pull(stream, "me");
    },
    Error,
    ErrorCode.Timeout,
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub - multiple consumers", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  const buf: Promise<PubAck>[] = [];
  for (let i = 0; i < 100; i++) {
    buf.push(js.publish(subj, Empty));
  }
  await Promise.all(buf);

  let ci = await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(ci.num_pending, 100);

  let countA = 0;
  let countB = 0;
  const m = new Map<number, number>();

  const opts = consumerOpts();
  opts.durable("me");
  opts.ackExplicit();
  opts.deliverAll();
  const subA = await js.pullSubscribe(subj, opts);
  (async () => {
    for await (const msg of subA) {
      const v = m.get(msg.seq) ?? 0;
      m.set(msg.seq, v + 1);
      countA++;
      msg.ack();
    }
  })().then();

  const subB = await js.pullSubscribe(subj, opts);
  (async () => {
    for await (const msg of subB) {
      const v = m.get(msg.seq) ?? 0;
      m.set(msg.seq, v + 1);
      countB++;
      msg.ack();
    }
  })().then();

  const done = deferred<void>();
  const interval = setInterval(() => {
    if (countA + countB < 100) {
      subA.pull({ expires: 500, batch: 25 });
      subB.pull({ expires: 500, batch: 25 });
    } else {
      clearInterval(interval);
      done.resolve();
    }
  }, 25);

  await done;

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assert(countA > 0);
  assert(countB > 0);
  assertEquals(countA + countB, 100);

  for (let i = 1; i <= 100; i++) {
    assertEquals(m.get(i), 1);
  }

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull next", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const js = jetstream(nc);
  await js.publish(subj);
  await js.publish(subj);

  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 2);

  let inbox = "";
  const opts = consumerOpts();
  opts.durable("me");
  opts.ackExplicit();
  opts.manualAck();
  opts.callback((err, msg) => {
    if (err) {
      if (err.code === ErrorCode.JetStream408RequestTimeout) {
        sub.unsubscribe();
        return;
      } else {
        fail(err.message);
      }
    }
    if (msg) {
      msg.next(inbox, { batch: 1, expires: 250 });
    }
  });
  const sub = await js.pullSubscribe(subj, opts);
  inbox = sub.getSubject();
  sub.pull({ batch: 1, expires: 1000 });

  await sub.closed;

  const subin = sub as unknown as JetStreamSubscriptionInfoable;
  assert(subin.info);
  assertEquals(subin.info.attached, false);
  await sub.closed;

  const ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 2);
  assertEquals(ci.ack_floor.stream_seq, 2);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull errors", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));

  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = jetstream(nc);

  async function expectError(
    expires: number,
    code: ErrorCode,
  ) {
    try {
      await js.pull(stream, "me", expires);
    } catch (err) {
      assertEquals((err as NatsError).code, code);
    }
  }

  await expectError(0, ErrorCode.JetStream404NoMessages);
  await expectError(1000, ErrorCode.JetStream408RequestTimeout);

  await js.publish(subj);

  // we expect a message
  const a = await js.pull(stream, "me", 1000);
  assertEquals(a.seq, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull error: max_waiting", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.8.2")) {
    return;
  }

  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    max_waiting: 1,
  });
  const js = jetstream(nc);

  async function expectError(
    expires: number,
    code: ErrorCode,
  ): Promise<NatsError> {
    const d = deferred<NatsError>();
    try {
      await js.pull(stream, "me", expires);
    } catch (err) {
      d.resolve(err as NatsError);
      assertEquals((err as NatsError).code, code);
    }
    return d;
  }
  await Promise.all([
    expectError(
      3000,
      ErrorCode.JetStream408RequestTimeout,
    ),
    expectError(3000, ErrorCode.JetStream409),
  ]);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull error: js not enabled", async () => {
  const { ns, nc } = await _setup(connect);
  const js = jetstream(nc);
  async function expectError(code: ErrorCode, expires: number) {
    const noMsgs = deferred<NatsError>();
    try {
      await js.pull("stream", "me", expires);
    } catch (err) {
      noMsgs.resolve(err as NatsError);
    }
    const ne = await noMsgs;
    assertEquals(ne.code, code);
  }

  await expectError(ErrorCode.JetStreamNotEnabled, 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - ephemeral pull consumer", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const d = deferred<JsMsg>();
  const js = jetstream(nc);

  // no durable name specified
  const opts = consumerOpts();
  opts.manualAck();
  opts.ackExplicit();
  opts.deliverAll();
  opts.inactiveEphemeralThreshold(500);
  opts.callback((_err, msg) => {
    assert(msg !== null);
    d.resolve(msg);
  });

  const sub = await js.pullSubscribe(subj, opts);
  const old = await sub.consumerInfo();

  const sc = StringCodec();
  await js.publish(subj, sc.encode("hello"));
  sub.pull({ batch: 1, expires: 1000 });

  const m = await d;
  assertEquals(sc.decode(m.data), "hello");

  sub.unsubscribe();
  await nc.flush();

  const jsm = await jetstreamManager(nc);
  await delay(1500);
  await assertRejects(
    async () => {
      await jsm.consumers.info(stream, old.name);
    },
    Error,
    "consumer not found",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull consumer max_bytes rejected on old servers", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  // change the version of the server to fail pull with max bytes
  const nci = nc as NatsConnectionImpl;
  nci.features.update("2.7.0");

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    filter_subject: ">",
  });
  const js = jetstream(nc) as JetStreamClientImpl;

  const d = deferred<NatsError>();

  const opts = consumerOpts();
  opts.deliverAll();
  opts.ackExplicit();
  opts.manualAck();
  opts.callback((err, _msg) => {
    if (err) {
      d.resolve(err);
    }
  });

  const sub = await js.pullSubscribe(subj, opts);
  assertThrows(
    () => {
      sub.pull({ expires: 2000, max_bytes: 2 });
    },
    Error,
    "max_bytes is only supported on servers 2.8.3 or better",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull on stopped server doesn't close client", async () => {
  let { ns, nc } = await _setup(connect, jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });
  (async () => {
    let reconnects = 0;
    for await (const s of nc.status()) {
      switch (s.type) {
        case DebugEvents.Reconnecting:
          reconnects++;
          if (reconnects === 2) {
            ns.restart().then((s) => {
              ns = s;
            });
          }
          break;
        case Events.Reconnect:
          setTimeout(() => {
            loop = false;
          });
          break;
        default:
          // nothing
      }
    }
  })().then();
  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.add({ name: nuid.next(), subjects: ["test"] });
  const { name: stream } = si.config;
  await jsm.consumers.add(stream, {
    durable_name: "dur",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  setTimeout(() => {
    ns.stop();
  }, 2000);

  let loop = true;
  let requestTimeouts = 0;
  while (true) {
    try {
      await js.pull(stream, "dur", 500);
    } catch (err) {
      switch ((err as NatsError).code) {
        case ErrorCode.Timeout:
          // js is not ready
          continue;
        case ErrorCode.JetStream408RequestTimeout:
          requestTimeouts++;
          break;
        default:
          fail(`unexpected error: ${(err as Error).message}`);
          break;
      }
    }
    if (!loop) {
      break;
    }
  }
  assert(requestTimeouts > 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull heartbeat", async () => {
  let { ns, nc } = await _setup(connect, jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });

  const reconnected = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === Events.Reconnect) {
        // if we reconnect, close the client
        reconnected.resolve();
      }
    }
  })().then();

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "my-stream", subjects: ["test"] });

  const js = jetstream(nc);

  const d = deferred();
  const opts = consumerOpts().ackExplicit().callback((err, m) => {
    if (err?.code === ErrorCode.JetStreamIdleHeartBeat) {
      d.resolve();
    }
    if (m) {
      m.ack();
    }
  });
  const psub = await js.pullSubscribe("test", opts);
  await ns.stop();

  psub.pull({ idle_heartbeat: 500, expires: 5000, batch: 1 });
  await d;

  ns = await ns.restart();
  // this here because otherwise get a resource leak error in the test
  await reconnected;
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull heartbeat iter", async () => {
  let { ns, nc } = await _setup(connect, jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });

  const reconnected = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === Events.Reconnect) {
        // if we reconnect, close the client
        reconnected.resolve();
      }
    }
  })().then();

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "my-stream", subjects: ["test"] });

  const js = jetstream(nc);

  const opts = consumerOpts().ackExplicit();
  const psub = await js.pullSubscribe("test", opts);
  const done = assertRejects(
    async () => {
      for await (const m of psub) {
        m.ack();
      }
    },
    Error,
    "idle heartbeats missed",
  );

  await ns.stop();
  psub.pull({ idle_heartbeat: 500, expires: 5000, batch: 1 });
  await done;

  ns = await ns.restart();
  // this here because otherwise get a resource leak error in the test
  await reconnected;
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull multi-subject filter", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const name = nuid.next();
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await jsm.streams.add({ name, subjects: [`a.>`] });

  const opts = consumerOpts()
    .durable("me")
    .ackExplicit()
    .filterSubject("a.b")
    .filterSubject("a.c")
    .callback((_err, msg) => {
      msg?.ack();
    });

  const sub = await js.pullSubscribe("a.>", opts);
  const ci = await sub.consumerInfo();
  assertExists(ci.config.filter_subjects);
  assertArrayIncludes(ci.config.filter_subjects, ["a.b", "a.c"]);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull consumer deleted", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const name = nuid.next();
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
  });

  const d = deferred<NatsError>();
  const js = jetstream(nc);

  js.pull(name, name, 5000)
    .catch((err) => {
      d.resolve(err);
    });
  await nc.flush();
  await jsm.consumers.delete(name, name);

  const err = await d;
  assertEquals(err?.message, "consumer deleted");

  await cleanup(ns, nc);
});

Deno.test("jetstream - pullSub cb consumer deleted", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const name = nuid.next();
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
  });

  const d = deferred<NatsError>();
  const js = jetstream(nc);

  const opts = consumerOpts().bind(name, name).callback((err, _m) => {
    if (err) {
      d.resolve(err);
    }
  });
  const sub = await js.pullSubscribe(name, opts);
  sub.pull({ expires: 5000 });
  await nc.flush();
  await jsm.consumers.delete(name, name);

  const err = await d;
  assertEquals(err?.message, "consumer deleted");

  await cleanup(ns, nc);
});

Deno.test("jetstream - pullSub iter consumer deleted", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const name = nuid.next();
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
  });

  const d = deferred<NatsError>();
  const js = jetstream(nc);

  const opts = consumerOpts().bind(name, name);

  const sub = await js.pullSubscribe(name, opts);
  (async () => {
    for await (const _m of sub) {
      // nothing
    }
  })().catch((err) => {
    d.resolve(err);
  });
  sub.pull({ expires: 5000 });
  await nc.flush();
  await jsm.consumers.delete(name, name);

  const err = await d;
  assertEquals(err?.message, "consumer deleted");

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sync", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const name = nuid.next();
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);

  await js.publish(name);
  await js.publish(name);

  const sub = await js.pullSubscribe(name, consumerOpts().bind(name, name));
  sub.pull({ batch: 2, no_wait: true });
  const sync = syncIterator(sub);

  assertExists(await sync.next());
  assertExists(await sync.next());
  // if don't unsubscribe, the call will hang because
  // we are waiting for the sub.pull() to happen
  sub.unsubscribe();
  assertEquals(await sync.next(), null);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull single filter", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const name = nuid.next();
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await jsm.streams.add({ name, subjects: [`a.>`] });

  const opts = consumerOpts()
    .durable("me")
    .ackExplicit()
    .filterSubject("a.b")
    .callback((_err, msg) => {
      msg?.ack();
    });

  const sub = await js.pullSubscribe("a.>", opts);
  const ci = await sub.consumerInfo();
  assertEquals(ci.config.filter_subject, "a.b");

  await cleanup(ns, nc);
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
  const m = await js.pull(n, "B");
  assertEquals(m.seq, 3);

  await cleanup(ns, nc);
});
