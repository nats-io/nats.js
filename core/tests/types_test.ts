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

import { connect } from "./connect.ts";
import type { Msg, NatsConnection } from "../src/internal_mod.ts";
import { createInbox, DataBuffer, deferred } from "../src/internal_mod.ts";
import { assert, assertEquals } from "jsr:@std/assert";
import { NatsServer } from "../../test_helpers/launcher.ts";

function mh(nc: NatsConnection, subj: string): Promise<Msg> {
  const dm = deferred<Msg>();
  const sub = nc.subscribe(subj, { max: 1 });
  (async () => {
    for await (const m of sub) {
      dm.resolve(m);
    }
  })().then();
  return dm;
}

Deno.test("types - json types", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const subj = createInbox();
  const dm = mh(nc, subj);
  nc.publish(subj, JSON.stringify(6691));
  const msg = await dm;
  assertEquals(typeof msg.json(), "number");
  assertEquals(msg.json<number>(), 6691);
  await nc.close();
  await ns.stop();
});

Deno.test("types - string types", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const subj = createInbox();
  const dm = mh(nc, subj);
  nc.publish(subj, "hello world");
  const msg = await dm;
  assertEquals(msg.string(), "hello world");
  await nc.close();
  await ns.stop();
});

Deno.test("types - binary types", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const subj = createInbox();
  const dm = mh(nc, subj);
  const payload = DataBuffer.fromAscii("hello world");
  nc.publish(subj, payload);
  const msg = await dm;
  assert(msg.data instanceof Uint8Array);
  assertEquals(msg.data, payload);
  await nc.close();
  await ns.stop();
});
