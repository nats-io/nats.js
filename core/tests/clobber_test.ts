/*
 * Copyright 2020-2023 The NATS Authors
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

import { NatsServer } from "../../test_helpers/launcher.ts";
import { createInbox, DataBuffer } from "../src/internal_mod.ts";
import { connect } from "./connect.ts";
import { assertEquals } from "@std/assert";

function makeBuffer(N: number): Uint8Array {
  const buf = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    buf[i] = "a".charCodeAt(0) + (i % 26);
  }
  return buf;
}

Deno.test("clobber - buffers don't clobber", async () => {
  const iters = 250 * 1024;
  const data = makeBuffer(iters * 1024);
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const subj = createInbox();
  const sub = nc.subscribe(subj, { max: iters });
  const payloads = new DataBuffer();
  const iter = (async () => {
    for await (const m of sub) {
      payloads.fill(m.data);
    }
  })();

  let bytes = 0;
  for (let i = 0; i < iters; i++) {
    bytes += 1024;
    const start = i * 1024;
    nc.publish(subj, data.subarray(start, start + 1024));
  }

  await iter;

  const td = new TextDecoder();
  for (let i = 0; i < iters; i++) {
    const start = i * 1024;
    const r = td.decode(payloads.drain(1024));
    const w = td.decode(data.subarray(start, start + 1024));
    assertEquals(r, w);
  }

  await nc.close();
  await ns.stop();
});
