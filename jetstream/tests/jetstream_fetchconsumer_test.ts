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
  assertBetween,
  cleanup,
  connect,
  jetstreamServerConf,
} from "test_helpers";
import { initStream, time } from "./jstest_util.ts";
import { AckPolicy, StorageType } from "../src/jsapi_types.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
  fail,
} from "jsr:@std/assert";
import {
  DebugEvents,
  deferred,
  Empty,
  Events,
  nuid,
  syncIterator,
} from "@nats-io/nats-core";
import type {
  NatsConnectionImpl,
  NatsError,
} from "@nats-io/nats-core/internal";

import { Js409Errors } from "../src/jsutil.ts";
import { consume } from "./jstest_util.ts";
import { jetstream, jetstreamManager } from "../src/mod.ts";

Deno.test("jetstream - fetch expires waits", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = jetstream(nc);
  const start = Date.now();
  const iter = js.fetch(stream, "me", { expires: 1000 });
  await (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })();
  const elapsed = Date.now() - start;
  assertBetween(elapsed, 950, 1050);
  assertEquals(iter.getReceived(), 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch expires waits after initial", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = jetstream(nc);
  await js.publish(subj, Empty);
  const start = Date.now();
  const iter = js.fetch(stream, "me", { expires: 1000, batch: 5 });
  await (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })();
  const elapsed = Date.now() - start;
  assertBetween(elapsed, 950, 1050);
  assertEquals(iter.getReceived(), 1);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch expires or no_wait is required", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  assertThrows(
    () => {
      js.fetch(stream, "me");
    },
    Error,
    "expires or no_wait is required",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch: no_wait with more left", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  await js.publish(subj);
  await js.publish(subj);

  const iter = js.fetch(stream, "me", { no_wait: true });
  await consume(iter);

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch some messages", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  // try to get messages = none available
  let sub = await js.fetch(stream, "me", { batch: 2, no_wait: true });
  await (async () => {
    for await (const m of sub) {
      m.ack();
    }
  })();
  assertEquals(sub.getProcessed(), 0);

  // seed some messages
  await js.publish(subj, Empty, { msgID: "a" });
  await js.publish(subj, Empty, { msgID: "b" });
  await js.publish(subj, Empty, { msgID: "c" });

  // try to get 2 messages - OK
  sub = await js.fetch(stream, "me", { batch: 2, no_wait: true });
  await (async () => {
    for await (const m of sub) {
      m.ack();
    }
  })();
  assertEquals(sub.getProcessed(), 2);

  await nc.flush();
  let ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 1);
  assertEquals(ci.delivered.stream_seq, 2);
  assertEquals(ci.ack_floor.stream_seq, 2);

  // try to get 2 messages - OK, but only gets 1
  sub = await js.fetch(stream, "me", { batch: 2, no_wait: true });
  await (async () => {
    for await (const m of sub) {
      m.ack();
    }
  })();
  assertEquals(sub.getProcessed(), 1);

  await nc.flush();
  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 3);
  assertEquals(ci.ack_floor.stream_seq, 3);

  // try to get 2 messages - OK, none available
  sub = await js.fetch(stream, "me", { batch: 2, no_wait: true });
  await (async () => {
    for await (const m of sub) {
      m.ack();
    }
  })();
  assertEquals(sub.getProcessed(), 0);

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch none - breaks after expires", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const sw = time();
  const batch = js.fetch(stream, "me", {
    batch: 10,
    expires: 1000,
  });
  const done = (async () => {
    for await (const _m of batch) {
      fail("expected no messages");
    }
  })();

  await done;
  sw.mark();
  sw.assertInRange(1000);
  assertEquals(batch.getReceived(), 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch none - no wait breaks fast", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const sw = time();
  const batch = js.fetch(stream, "me", {
    batch: 10,
    no_wait: true,
  });
  const done = (async () => {
    for await (const m of batch) {
      m.ack();
    }
  })();

  await done;
  sw.mark();
  assertBetween(sw.duration(), 0, 500);
  assertEquals(batch.getReceived(), 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch one - no wait breaks fast", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  await js.publish(subj);

  const sw = time();
  const batch = js.fetch(stream, "me", {
    batch: 10,
    no_wait: true,
  });
  const done = (async () => {
    for await (const m of batch) {
      m.ack();
    }
  })();

  await done;
  sw.mark();
  // console.log({ duration: sw.duration() });
  const duration = sw.duration();
  assert(150 > duration, `${duration}`);
  assertEquals(batch.getReceived(), 1);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch none - cancel timers", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const sw = time();
  const batch = js.fetch(stream, "me", {
    batch: 10,
    expires: 1000,
  });
  const done = (async () => {
    for await (const m of batch) {
      m.ack();
    }
  })();

  const nci = nc as NatsConnectionImpl;
  const last = nci.protocol.subscriptions.sidCounter;
  const sub = nci.protocol.subscriptions.get(last);
  assert(sub);
  sub.unsubscribe();

  await done;
  sw.mark();
  assert(25 > sw.duration());
  assertEquals(batch.getReceived(), 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch one - breaks after expires", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = jetstream(nc);
  await js.publish(subj);

  const sw = time();
  const batch = js.fetch(stream, "me", {
    batch: 10,
    expires: 1000,
  });
  const done = (async () => {
    for await (const m of batch) {
      m.ack();
    }
  })();

  await done;
  sw.mark();
  sw.assertInRange(1000);
  assertEquals(batch.getReceived(), 1);
  await cleanup(ns, nc);
});

// Deno.test("jetstream - cross account fetch", async () => {
//   const { ns, nc: admin } = await _setup(connect,
//     jetstreamExportServerConf(),
//     {
//       user: "js",
//       pass: "js",
//     },
//   );
//
//   // add a stream
//   const { stream, subj } = await initStream(admin);
//   const admjs = admin.jetstream();
//   await admjs.publish(subj, Empty, {msgID: "1"});
//   await admjs.publish(subj, Empty, {msgID: "2"});
//
//   const admjsm = await admin.jetstreamManager();
//
//   // create a durable config
//   const bo = consumerOpts() as ConsumerOptsBuilderImpl;
//   bo.manualAck();
//   bo.ackExplicit();
//   bo.durable("me");
//   bo.maxAckPending(10);
//   const opts = bo.getOpts();
//   await admjsm.consumers.add(stream, opts.config);
//
//   const nc = await connect({
//     port: ns.port,
//     user: "a",
//     pass: "s3cret",
//     inboxPrefix: "A",
//     debug: true,
//   });
//
//   // the api prefix is not used for pull/fetch()
//   const js = nc.jetstream({ apiPrefix: "IPA" });
//   let iter = js.fetch(stream, "me", { batch: 20, expires: 1000 });
//   const msgs = await consume(iter);
//
//   assertEquals(msgs.length, 2);
//
//   // msg = await js.pull(stream, "me");
//   // assertEquals(msg.seq, 2);
//   // await assertThrowsAsync(async () => {
//   //   await js.pull(stream, "me");
//   // }, Error, "No Messages");
//
//   await cleanup(ns, admin, nc);
// });

Deno.test("jetstream - idleheartbeat missed on fetch", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const iter = js.fetch(stream, "me", {
    expires: 2000,
    idle_heartbeat: 250,
    //@ts-ignore: testing
    delay_heartbeat: true,
  });

  await assertRejects(
    async () => {
      for await (const _m of iter) {
        // no message expected
      }
    },
    Error,
    Js409Errors.IdleHeartbeatMissed,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - idleheartbeat on fetch", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = jetstream(nc);
  const iter = js.fetch(stream, "me", {
    expires: 2000,
    idle_heartbeat: 250,
  });

  // we don't expect this to throw
  await (async () => {
    for await (const _m of iter) {
      // no message expected
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch on stopped server doesn't close client", async () => {
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
  while (true) {
    try {
      const iter = js.fetch(stream, "dur", { batch: 1, expires: 500 });
      for await (const m of iter) {
        m.ack();
      }
      if (!loop) {
        break;
      }
    } catch (err) {
      fail(`shouldn't have errored: ${err.message}`);
    }
  }
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch heartbeat", async () => {
  let { ns, nc } = await _setup(connect, jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });

  const d = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === Events.Reconnect) {
        // if we reconnect, close the client
        d.resolve();
      }
    }
  })().then();

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "my-stream", subjects: ["test"] });
  const js = jetstream(nc);
  await ns.stop();

  const iter = js.fetch("my-stream", "dur", {
    batch: 1,
    expires: 5000,
    idle_heartbeat: 500,
  });

  await assertRejects(
    async () => {
      for await (const m of iter) {
        m.ack();
      }
    },
    Error,
    "idle heartbeats missed",
  );
  ns = await ns.restart();
  // this here because otherwise get a resource leak error in the test
  await d;
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch consumer deleted", async () => {
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

  const iter = js.fetch(name, name, { expires: 5000 });
  (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })().catch((err) => {
    d.resolve(err);
  });
  await nc.flush();
  await jsm.consumers.delete(name, name);

  const err = await d;
  assertEquals(err?.message, "consumer deleted");

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch sync", async () => {
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

  const iter = js.fetch(name, name, { batch: 2, no_wait: true });
  const sync = syncIterator(iter);
  assertExists(await sync.next());
  assertExists(await sync.next());
  assertEquals(await sync.next(), null);

  await cleanup(ns, nc);
});
