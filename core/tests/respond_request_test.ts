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
import { cleanup, setup } from "nst";
import type {
  Msg,
  MsgImpl,
  NatsConnection,
  NatsConnectionImpl,
} from "../src/internal_mod.ts";
import { createInbox, deferred, headers } from "../src/internal_mod.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { errors } from "../src/errors.ts";

// a received message whose reply subject is the specified one
async function msgWithReply(nc: NatsConnection, reply?: string): Promise<Msg> {
  const subj = createInbox();
  const d = deferred<Msg>();
  nc.subscribe(subj, { max: 1, callback: (_err, msg) => d.resolve(msg) });
  nc.publish(subj, "", { reply });
  return await d;
}

Deno.test("respondRequest - resolves with the response", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;
  const svc = createInbox();
  nc.subscribe(svc, {
    callback: (_err, msg) => {
      const h = headers();
      h.set("x", msg.headers?.get("x") || "");
      msg.respond(msg.data, { headers: h });
    },
  });

  const m = await msgWithReply(nc, svc);
  // the message publisher is the protocol, which satisfies the replier
  assertEquals((m as MsgImpl).publisher, nci.protocol);

  const h = headers();
  h.set("x", "y");
  const r = await m.respondRequest("hello", { headers: h });
  assertEquals(r.string(), "hello");
  assertEquals(r.headers?.get("x"), "y");
  assertEquals(nci.protocol.muxSubscriptions.size(), 0);
  await cleanup(ns, nc);
});

Deno.test("respondRequest - no reply subject", async () => {
  const { ns, nc } = await setup();
  const m = await msgWithReply(nc);
  await assertRejects(
    () => m.respondRequest(),
    errors.InvalidArgumentError,
    "'reply' is required",
  );
  await cleanup(ns, nc);
});

Deno.test("respondRequest - timeout", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;
  const svc = createInbox();
  nc.subscribe(svc, { callback: () => {} });

  const m = await msgWithReply(nc, svc);
  const start = Date.now();
  await assertRejects(
    () => m.respondRequest("", { timeout: 250 }),
    errors.TimeoutError,
  );
  assert(Date.now() - start < 2000);
  assertEquals(nci.protocol.muxSubscriptions.size(), 0);
  await cleanup(ns, nc);
});

Deno.test("respondRequest - default timeout", async () => {
  const { ns, nc } = await setup();
  const svc = createInbox();
  nc.subscribe(svc, { callback: () => {} });

  const m = await msgWithReply(nc, svc);
  const start = Date.now();
  await assertRejects(
    () => m.respondRequest(),
    errors.TimeoutError,
  );
  assert(Date.now() - start >= 2000);
  await cleanup(ns, nc);
});

Deno.test("respondRequest - no responders", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;

  const m = await msgWithReply(nc, createInbox());
  const err = await assertRejects(
    () => m.respondRequest(),
    errors.RequestError,
  );
  assert(err.isNoResponders());
  assertEquals(nci.protocol.muxSubscriptions.size(), 0);
  await cleanup(ns, nc);
});
