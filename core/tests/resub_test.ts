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

import { cleanup, setup } from "test_helpers";
import { createInbox } from "../src/internal_mod.ts";
import type {
  Msg,
  NatsConnection,
  NatsConnectionImpl,
} from "../src/internal_mod.ts";
import { assert, assertEquals, assertExists, fail } from "jsr:@std/assert";
import type { NatsServer } from "../../test_helpers/launcher.ts";

Deno.test("resub - iter", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;
  const subja = createInbox();

  const sub = nc.subscribe(subja, { max: 2 });
  const buf: Msg[] = [];
  (async () => {
    for await (const m of sub) {
      buf.push(m);
      m.respond();
    }
  })().then();

  await nc.request(subja);

  const subjb = createInbox();
  nci._resub(sub, subjb);
  assertEquals(sub.getSubject(), subjb);

  await nc.request(subjb);

  assertEquals(sub.getProcessed(), 2);
  assertEquals(buf.length, 2);
  assertEquals(buf[0].subject, subja);
  assertEquals(buf[1].subject, subjb);
  await cleanup(ns, nc);
});

Deno.test("resub - callback", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;
  const subja = createInbox();
  const buf: Msg[] = [];

  const sub = nc.subscribe(subja, {
    max: 2,
    callback: (_err, msg) => {
      buf.push(msg);
      msg.respond();
    },
  });

  await nc.request(subja);

  const subjb = createInbox();
  nci._resub(sub, subjb);
  assertEquals(sub.getSubject(), subjb);

  await nc.request(subjb);

  assertEquals(sub.getProcessed(), 2);
  assertEquals(buf.length, 2);
  assertEquals(buf[0].subject, subja);
  assertEquals(buf[1].subject, subjb);
  await cleanup(ns, nc);
});

async function assertEqualSubs(
  ns: NatsServer,
  nc: NatsConnection,
): Promise<void> {
  const nci = nc as NatsConnectionImpl;
  const cid = nc.info?.client_id || -1;
  if (cid === -1) {
    fail("client_id not found");
  }

  const connz = await ns.connz(cid, "detail");

  const conn = connz.connections.find((c) => {
    return c.cid === cid;
  });
  assertExists(conn);
  assertExists(conn.subscriptions_list_detail);

  const subs = nci.protocol.subscriptions.all();
  subs.forEach((sub) => {
    const ssub = conn.subscriptions_list_detail?.find((d) => {
      return d.sid === `${sub.sid}`;
    });
    assertExists(ssub);
    assertEquals(ssub.subject, sub.subject);
  });
}

Deno.test("resub - removes server interest", async () => {
  const { ns, nc } = await setup();

  nc.subscribe("a", {
    callback() {
      // nothing
    },
  });
  await nc.flush();

  const nci = nc as NatsConnectionImpl;
  let sub = nci.protocol.subscriptions.all().find((s) => {
    return s.subject === "a";
  });
  assertExists(sub);

  // assert the server sees the same subscriptions
  await assertEqualSubs(ns, nc);

  // change it
  nci._resub(sub, "b");
  await nc.flush();

  // make sure we don't find a
  sub = nci.protocol.subscriptions.all().find((s) => {
    return s.subject === "a";
  });
  assert(sub === undefined);

  // make sure we find b
  sub = nci.protocol.subscriptions.all().find((s) => {
    return s.subject === "b";
  });
  assertExists(sub);

  // assert server thinks the same thing
  await assertEqualSubs(ns, nc);
  await cleanup(ns, nc);
});
