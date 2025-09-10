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

import { assertEquals } from "@std/assert";
import { createInbox, deferred } from "../src/internal_mod.ts";
import type { Msg } from "../src/internal_mod.ts";
import { cleanup, setup } from "test_helpers";

function macro(input: Uint8Array) {
  return async () => {
    const { ns, nc } = await setup();
    const subj = createInbox();
    const dm = deferred<Msg>();
    const sub = nc.subscribe(subj, { max: 1 });
    (async () => {
      for await (const m of sub) {
        dm.resolve(m);
      }
    })().then();

    nc.publish(subj, input);
    const msg = await dm;
    assertEquals(msg.data, input);
    await cleanup(ns, nc);
  };
}

const invalid2octet = new Uint8Array([0xc3, 0x28]);
const invalidSequenceIdentifier = new Uint8Array([0xa0, 0xa1]);
const invalid3octet = new Uint8Array([0xe2, 0x28, 0xa1]);
const invalid4octet = new Uint8Array([0xf0, 0x90, 0x28, 0xbc]);
const embeddedNull = new Uint8Array(
  [0x00, 0xf0, 0x00, 0x28, 0x00, 0x00, 0xf0, 0x9f, 0x92, 0xa9, 0x00],
);

Deno.test("binary - invalid2octet", macro(invalid2octet));
Deno.test(
  "binary - invalidSequenceIdentifier",
  macro(invalidSequenceIdentifier),
);
Deno.test("binary - invalid3octet", macro(invalid3octet));
Deno.test("binary - invalid4octet", macro(invalid4octet));
Deno.test("binary - embeddednull", macro(embeddedNull));
