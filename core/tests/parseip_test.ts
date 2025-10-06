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

import { ipV4, isIP, parseIP } from "../src/internal_mod.ts";

import { assert, assertEquals, assertFalse } from "@std/assert";

Deno.test("ipparser", () => {
  const tests = [
    { t: "127.0.1.2", e: ipV4(127, 0, 1, 2) },
    { t: "127.0.0.1", e: ipV4(127, 0, 0, 1) },
    { t: "127.001.002.003", e: ipV4(127, 1, 2, 3) },
    { t: "::ffff:127.1.2.3", e: ipV4(127, 1, 2, 3) },
    { t: "::ffff:127.001.002.003", e: ipV4(127, 1, 2, 3) },
    { t: "::ffff:7f01:0203", e: ipV4(127, 1, 2, 3) },
    { t: "0:0:0:0:0000:ffff:127.1.2.3", e: ipV4(127, 1, 2, 3) },
    { t: "0:0:0:0:000000:ffff:127.1.2.3", e: ipV4(127, 1, 2, 3) },
    { t: "0:0:0:0::ffff:127.1.2.3", e: ipV4(127, 1, 2, 3) },
    {
      t: "2001:4860:0:2001::68",
      e: new Uint8Array(
        [
          0x20,
          0x01,
          0x48,
          0x60,
          0,
          0,
          0x20,
          0x01,
          0,
          0,
          0,
          0,
          0,
          0,
          0x00,
          0x68,
        ],
      ),
    },
    {
      t: "2001:4860:0000:2001:0000:0000:0000:0068",
      e: new Uint8Array(
        [
          0x20,
          0x01,
          0x48,
          0x60,
          0,
          0,
          0x20,
          0x01,
          0,
          0,
          0,
          0,
          0,
          0,
          0x00,
          0x68,
        ],
      ),
    },

    { t: "-0.0.0.0", e: undefined },
    { t: "0.-1.0.0", e: undefined },
    { t: "0.0.-2.0", e: undefined },
    { t: "0.0.0.-3", e: undefined },
    { t: "127.0.0.256", e: undefined },
    { t: "abc", e: undefined },
    { t: "123:", e: undefined },
    { t: "fe80::1%lo0", e: undefined },
    { t: "fe80::1%911", e: undefined },
    { t: "", e: undefined },
    { t: "a1:a2:a3:a4::b1:b2:b3:b4", e: undefined }, // Issue 6628
  ];

  tests.forEach((tc) => {
    assertEquals(parseIP(tc.t), tc.e, tc.t);
  });
});

Deno.test("ipparser - isIP", () => {
  assert(isIP("127.0.0.1"));
  assert(isIP("192.168.1.1"));
  assert(isIP("2001:4860:0:2001::68"));
  assert(isIP("::1"));
  assert(isIP("::"));
  assertFalse(isIP(""));
  assertFalse(isIP("invalid"));
  assertFalse(isIP("256.0.0.1"));
});

Deno.test("ipparser - IPv6 edge cases", () => {
  // Empty IPv6 (all zeros)
  const emptyV6 = parseIP("::");
  assert(emptyV6 !== undefined);
  assertEquals(emptyV6, new Uint8Array(16));

  // Loopback
  const loopback = parseIP("::1");
  assert(loopback !== undefined);
  const expected = new Uint8Array(16);
  expected[15] = 1;
  assertEquals(loopback, expected);

  // IPv6 with hex number > 0xFFFF should fail
  assertEquals(parseIP("10000::1"), undefined);

  // IPv6 with invalid hex digits should fail
  assertEquals(parseIP("gggg::1"), undefined);

  // IPv6 with trailing data should fail
  assertEquals(parseIP("::1:extra"), undefined);

  // IPv6 with double ellipsis should fail
  assertEquals(parseIP("::1::2"), undefined);

  // IPv6 ending with single colon should fail
  assertEquals(parseIP("::1:"), undefined);

  // IPv6 with too many groups should fail
  assertEquals(parseIP("1:2:3:4:5:6:7:8:9"), undefined);

  // IPv6 mixed case hex (should work)
  assert(parseIP("fe80::1A2b:3C4d") !== undefined);
});

Deno.test("ipparser - IPv4 edge cases", () => {
  // Missing octets
  assertEquals(parseIP("127.0.0"), undefined);
  assertEquals(parseIP("127.0"), undefined);
  assertEquals(parseIP("127"), undefined);

  // Double dots
  assertEquals(parseIP("1.2..4"), undefined);

  // Octet starting with invalid character
  assertEquals(parseIP("127.a.0.1"), undefined);

  // Valid edge cases
  assertEquals(parseIP("0.0.0.0"), ipV4(0, 0, 0, 0));
  assertEquals(parseIP("255.255.255.255"), ipV4(255, 255, 255, 255));

  // Boundary: exactly 255 is valid
  assertEquals(parseIP("10.0.0.255"), ipV4(10, 0, 0, 255));
});
