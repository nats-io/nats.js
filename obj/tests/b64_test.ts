/*
 * Copyright 2024 Synadia Communications, Inc
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
  Base64Codec,
  Base64UrlCodec,
  Base64UrlPaddedCodec,
} from "../src/base64.ts";
import { assert, assertEquals, assertFalse } from "jsr:@std/assert";

Deno.test("b64 - Base64Codec", () => {
  // should match btoa
  assertEquals(Base64Codec.encode("hello"), btoa("hello"));
  assertEquals(Base64Codec.decode(btoa("hello")), "hello");

  // binary input
  const bin = new TextEncoder().encode("hello");
  assertEquals(Base64Codec.encode(bin), btoa("hello"));
  assertEquals(Base64Codec.decode(Base64Codec.encode(bin), true), bin);
});

Deno.test("b64 - Base64UrlCodec", () => {
  // URL encoding removes padding
  const v = btoa(encodeURI("hello/world/one+two")).replaceAll("=", "");

  assertEquals(Base64UrlCodec.encode("hello/world/one+two"), v);
  assertEquals(Base64UrlCodec.decode(v), "hello/world/one+two");
  assertFalse(v.endsWith("=="), "expected padded");

  // binary input
  const bin = new TextEncoder().encode("hello/world/one+two");
  assertEquals(Base64UrlCodec.encode(bin), v);
  assertEquals(Base64UrlCodec.decode(v, true), bin);
});

Deno.test("b64 - Base64UrlPaddedCodec", () => {
  // URL encoding removes padding
  const v = btoa(encodeURI("hello/world/one+two"));
  assert(v.endsWith("=="), "expected padded");
  assertEquals(Base64UrlPaddedCodec.encode("hello/world/one+two"), v);
  assertEquals(Base64UrlPaddedCodec.decode(v), "hello/world/one+two");

  // binary input
  const bin = new TextEncoder().encode("hello/world/one+two");
  assertEquals(Base64UrlPaddedCodec.encode(bin), v);
  assertEquals(Base64UrlPaddedCodec.decode(v, true), bin);
});
