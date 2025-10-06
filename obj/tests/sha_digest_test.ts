/*
 * Copyright 2025 The NATS Authors
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

import { assert, assertEquals, assertFalse } from "@std/assert";
import { checkSha256, parseSha256 } from "../src/sha_digest.parser.ts";

// Known SHA256 hash of "hello world" for testing
const HELLO_WORLD_SHA256 = new Uint8Array([
  0xb9,
  0x4d,
  0x27,
  0xb9,
  0x93,
  0x4d,
  0x3e,
  0x08,
  0xa5,
  0x2e,
  0x52,
  0xd7,
  0xda,
  0x7d,
  0xab,
  0xfa,
  0xc4,
  0x84,
  0xef,
  0xe3,
  0x7a,
  0x53,
  0x80,
  0xee,
  0x90,
  0x88,
  0xf7,
  0xac,
  0xe2,
  0xef,
  0xcd,
  0xe9,
]);
const HELLO_WORLD_HEX_LOWER =
  "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
const HELLO_WORLD_HEX_UPPER =
  "B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9";
const HELLO_WORLD_BASE64 = "uU0nuZNNPgilLlLX2n2r+sSE7+N6U4DukIj3rOLvzek=";
const HELLO_WORLD_BASE64_URL = "uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek=";

Deno.test("sha_digest - parseSha256 from all formats", () => {
  assertEquals(parseSha256(HELLO_WORLD_HEX_LOWER), HELLO_WORLD_SHA256);
  assertEquals(parseSha256(HELLO_WORLD_HEX_UPPER), HELLO_WORLD_SHA256);
  assertEquals(parseSha256(HELLO_WORLD_BASE64), HELLO_WORLD_SHA256);
  assertEquals(parseSha256(HELLO_WORLD_BASE64_URL), HELLO_WORLD_SHA256);
});

Deno.test("sha_digest - parseSha256 mixed case hex falls back to base64", () => {
  // Mixed case hex fails hex validation, tries base64 instead
  const mixedCase =
    "B94d27b9934D3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
  const result = parseSha256(mixedCase);
  // Compute expected: base64 decode of the mixed case string
  const expected = Uint8Array.from(atob(mixedCase), (c) => c.charCodeAt(0));
  assertEquals(result, expected);
});

Deno.test("sha_digest - parseSha256 odd length hex falls back to base64", () => {
  // Odd length fails hex validation, tries base64 instead
  const oddLength =
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde";
  const result = parseSha256(oddLength);
  // Compute expected: base64 decode of the odd length string
  const expected = Uint8Array.from(atob(oddLength), (c) => c.charCodeAt(0));
  assertEquals(result, expected);
});

Deno.test("sha_digest - parseSha256 valid base64-like string", () => {
  // "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=" is base64 for "abcdefghijklmnopqrstuvwxyz"
  const validBase64Chars = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=";
  const result = parseSha256(validBase64Chars);
  const expected = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz");
  assertEquals(result, expected);
});

Deno.test("sha_digest - parseSha256 empty string returns empty array", () => {
  const result = parseSha256("");
  assert(result !== null);
  assertEquals(result.length, 0);
});

Deno.test("sha_digest - checkSha256 with matching hex strings (lowercase)", () => {
  const result = checkSha256(HELLO_WORLD_HEX_LOWER, HELLO_WORLD_HEX_LOWER);
  assert(result);
});

Deno.test("sha_digest - checkSha256 with matching hex strings (uppercase)", () => {
  const result = checkSha256(HELLO_WORLD_HEX_UPPER, HELLO_WORLD_HEX_UPPER);
  assert(result);
});

Deno.test("sha_digest - checkSha256 with matching different case hex", () => {
  const result = checkSha256(HELLO_WORLD_HEX_LOWER, HELLO_WORLD_HEX_UPPER);
  assert(result);
});

Deno.test("sha_digest - checkSha256 with matching base64 strings", () => {
  const result = checkSha256(HELLO_WORLD_BASE64, HELLO_WORLD_BASE64);
  assert(result);
});

Deno.test("sha_digest - checkSha256 with hex and base64 (same hash)", () => {
  const result = checkSha256(HELLO_WORLD_HEX_LOWER, HELLO_WORLD_BASE64);
  assert(result);
});

Deno.test("sha_digest - checkSha256 with base64 and hex (same hash)", () => {
  const result = checkSha256(HELLO_WORLD_BASE64, HELLO_WORLD_HEX_UPPER);
  assert(result);
});

Deno.test("sha_digest - checkSha256 with Uint8Array inputs", () => {
  const bytes1 = parseSha256(HELLO_WORLD_HEX_LOWER)!;
  const bytes2 = parseSha256(HELLO_WORLD_BASE64)!;
  const result = checkSha256(bytes1, bytes2);
  assert(result);
});

Deno.test("sha_digest - checkSha256 with mixed string and Uint8Array", () => {
  const bytes = parseSha256(HELLO_WORLD_HEX_LOWER)!;
  const result = checkSha256(bytes, HELLO_WORLD_BASE64);
  assert(result);
});

Deno.test("sha_digest - checkSha256 returns false for different hashes", () => {
  const other =
    "a94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
  const result = checkSha256(HELLO_WORLD_HEX_LOWER, other);
  assertFalse(result);
});

Deno.test("sha_digest - checkSha256 returns false for invalid input", () => {
  const result = checkSha256("invalid", HELLO_WORLD_HEX_LOWER);
  assertFalse(result);
});

Deno.test("sha_digest - checkSha256 returns false for different length arrays", () => {
  const short = new Uint8Array([0xb9, 0x4d]);
  const long = parseSha256(HELLO_WORLD_HEX_LOWER)!;
  const result = checkSha256(short, long);
  assertFalse(result);
});

Deno.test("sha_digest - checkSha256 returns false when first byte differs", () => {
  const original = parseSha256(HELLO_WORLD_HEX_LOWER)!;
  const modified = new Uint8Array(original);
  modified[0] = 0x00; // Change first byte
  const result = checkSha256(original, modified);
  assertFalse(result);
});

Deno.test("sha_digest - checkSha256 returns false when last byte differs", () => {
  const original = parseSha256(HELLO_WORLD_HEX_LOWER)!;
  const modified = new Uint8Array(original);
  modified[31] = 0x00; // Change last byte
  const result = checkSha256(original, modified);
  assertFalse(result);
});

Deno.test("sha_digest - parseSha256 rejects odd length hex", () => {
  // Hex parsing should fail on odd length, fallback to base64
  const oddHex = "abc"; // 3 chars (odd)
  const result = parseSha256(oddHex);
  // It will try base64 decode instead
  const expected = Uint8Array.from(atob(oddHex), (c) => c.charCodeAt(0));
  assertEquals(result, expected);
});

Deno.test("sha_digest - parseSha256 returns null for unrecognized format", () => {
  // String with special characters that fails both hex and base64 detection
  const invalid = "!@#$%^&*()";
  const result = parseSha256(invalid);
  assertEquals(result, null);
});

Deno.test("sha_digest - checkSha256 returns false when parseSha256 returns null", () => {
  // Both inputs invalid
  const invalid1 = "!@#$";
  const invalid2 = "^&*()";
  assertFalse(checkSha256(invalid1, invalid2));

  // One invalid, one valid
  assertFalse(checkSha256(invalid1, HELLO_WORLD_HEX_LOWER));
  assertFalse(checkSha256(HELLO_WORLD_HEX_LOWER, invalid2));
});
