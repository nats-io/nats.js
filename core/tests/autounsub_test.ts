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
import { assertEquals, assertRejects } from "jsr:@std/assert";

import { createInbox, Empty, errors } from "../src/internal_mod.ts";
import type { NatsConnectionImpl, Subscription } from "../src/internal_mod.ts";
import { _setup, cleanup, Lock } from "test_helpers";
import { connect } from "./connect.ts";
import { TimeoutError } from "../src/errors.ts";

Deno.test("autounsub - max option", async () => {
  const { ns, nc } = await _setup(connect);
  const subj = createInbox();
  const sub = nc.subscribe(subj, { max: 10 });
  for (let i = 0; i < 20; i++) {
    nc.publish(subj);
  }
  await nc.flush();
  assertEquals(sub.getReceived(), 10);
  await cleanup(ns, nc);
});

Deno.test("autounsub - unsubscribe", async () => {
  const { ns, nc } = await _setup(connect);
  const subj = createInbox();
  const sub = nc.subscribe(subj, { max: 10 });
  sub.unsubscribe(11);
  for (let i = 0; i < 20; i++) {
    nc.publish(subj);
  }
  await nc.flush();
  assertEquals(sub.getReceived(), 11);
  await cleanup(ns, nc);
});

Deno.test("autounsub - can unsub from auto-unsubscribed", async () => {
  const { ns, nc } = await _setup(connect);
  const subj = createInbox();
  const sub = nc.subscribe(subj, { max: 1 });
  for (let i = 0; i < 20; i++) {
    nc.publish(subj);
  }
  await nc.flush();
  assertEquals(sub.getReceived(), 1);
  sub.unsubscribe();
  await cleanup(ns, nc);
});

Deno.test("autounsub - can break to unsub", async () => {
  const { ns, nc } = await _setup(connect);
  const subj = createInbox();
  const sub = nc.subscribe(subj, { max: 20 });
  const iter = (async () => {
    for await (const _m of sub) {
      break;
    }
  })();
  for (let i = 0; i < 20; i++) {
    nc.publish(subj);
  }
  await nc.flush();
  await iter;
  assertEquals(sub.getProcessed(), 1);
  await cleanup(ns, nc);
});

Deno.test("autounsub - can change auto-unsub to a higher value", async () => {
  const { ns, nc } = await _setup(connect);
  const subj = createInbox();
  const sub = nc.subscribe(subj, { max: 1 });
  sub.unsubscribe(10);
  for (let i = 0; i < 20; i++) {
    nc.publish(subj);
  }
  await nc.flush();
  assertEquals(sub.getReceived(), 10);
  await cleanup(ns, nc);
});

Deno.test("autounsub - request receives expected count with multiple helpers", async () => {
  const { ns, nc } = await _setup(connect);
  const subj = createInbox();

  const fn = async (sub: Subscription) => {
    for await (const m of sub) {
      m.respond();
    }
  };
  const subs: Subscription[] = [];
  for (let i = 0; i < 5; i++) {
    const sub = nc.subscribe(subj);
    fn(sub).then();
    subs.push(sub);
  }
  await nc.request(subj);
  await nc.drain();

  const counts = subs.map((s) => {
    return s.getReceived();
  });
  const count = counts.reduce((a, v) => a + v);
  assertEquals(count, 5);

  await ns.stop();
});

Deno.test("autounsub - manual request receives expected count with multiple helpers", async () => {
  const { ns, nc } = await _setup(connect);
  const subj = createInbox();
  const lock = Lock(5);

  const fn = async (sub: Subscription) => {
    for await (const m of sub) {
      m.respond();
      lock.unlock();
    }
  };
  for (let i = 0; i < 5; i++) {
    const sub = nc.subscribe(subj);
    fn(sub).then();
  }
  const replySubj = createInbox();
  const sub = nc.subscribe(replySubj);
  nc.publish(subj, Empty, { reply: replySubj });
  await lock;
  await nc.drain();
  assertEquals(sub.getReceived(), 5);
  await ns.stop();
});

Deno.test("autounsub - check subscription leaks", async () => {
  const { ns, nc } = await _setup(connect);
  const nci = nc as NatsConnectionImpl;
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  sub.unsubscribe();
  assertEquals(nci.protocol.subscriptions.size(), 0);
  await cleanup(ns, nc);
});

Deno.test("autounsub - check request leaks", async () => {
  const { ns, nc } = await _setup(connect);
  const nci = nc as NatsConnectionImpl;
  const subj = createInbox();

  // should have no subscriptions
  assertEquals(nci.protocol.subscriptions.size(), 0);

  const sub = nc.subscribe(subj);
  (async () => {
    for await (const m of sub) {
      m.respond();
    }
  })().then();

  // should have one subscription
  assertEquals(nci.protocol.subscriptions.size(), 1);

  const msgs = [];
  msgs.push(nc.request(subj));
  msgs.push(nc.request(subj));

  // should have 2 mux subscriptions, and 2 subscriptions
  assertEquals(nci.protocol.subscriptions.size(), 2);
  assertEquals(nci.protocol.muxSubscriptions.size(), 2);

  await Promise.all(msgs);

  // mux subs should have pruned
  assertEquals(nci.protocol.muxSubscriptions.size(), 0);

  sub.unsubscribe();
  assertEquals(nci.protocol.subscriptions.size(), 1);
  await cleanup(ns, nc);
});

Deno.test("autounsub - check cancelled request leaks", async () => {
  const { ns, nc } = await _setup(connect);
  const nci = nc as NatsConnectionImpl;
  const subj = createInbox();

  // should have no subscriptions
  assertEquals(nci.protocol.subscriptions.size(), 0);

  const rp = nc.request(subj, Empty, { timeout: 100 });

  assertEquals(nci.protocol.subscriptions.size(), 1);
  assertEquals(nci.protocol.muxSubscriptions.size(), 1);

  await assertRejects(
    () => {
      return rp;
    },
    errors.RequestError,
    subj,
  );
  // the rejection should be timeout

  // mux subs should have pruned
  assertEquals(nci.protocol.muxSubscriptions.size(), 0);
  await cleanup(ns, nc);
});

Deno.test("autounsub - timeout cancelled request leaks", async () => {
  const { ns, nc } = await _setup(connect);
  const nci = nc as NatsConnectionImpl;
  const subj = createInbox();

  // should have no subscriptions
  assertEquals(nci.protocol.subscriptions.size(), 0);

  nci.subscribe(subj, {
    callback: () => {
      // ignored so it times out
    },
  });

  const rp = nc.request(subj, Empty, { timeout: 250 });

  assertEquals(nci.protocol.subscriptions.size(), 2);
  assertEquals(nci.protocol.muxSubscriptions.size(), 1);

  // the rejection should be timeout
  await assertRejects(
    () => {
      return rp;
    },
    TimeoutError,
  );

  // mux subs should have pruned
  assertEquals(nci.protocol.muxSubscriptions.size(), 0);
  await cleanup(ns, nc);
});
