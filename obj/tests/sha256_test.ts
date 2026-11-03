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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { sha256 } from "js-sha256";
import {
  createSha256,
  getSha256Backend,
  setSha256Backend,
} from "../src/sha256.ts";

function hex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.test("sha256 - matches js-sha256 on single update", async () => {
  const data = new TextEncoder().encode("hello world");
  const expected =
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

  const h = await createSha256();
  h.update(data);
  assertEquals(hex(h.digest()), expected);
});

Deno.test("sha256 - chunked equivalent to single buffer", async () => {
  const total = new Uint8Array(64 * 1024);
  for (let i = 0; i < total.length; i++) total[i] = (i * 31) & 0xff;

  // chunked through createSha256
  const h = await createSha256();
  for (let off = 0; off < total.length; off += 7919) {
    h.update(total.subarray(off, Math.min(off + 7919, total.length)));
  }
  const got = h.digest();

  // single-shot via js-sha256
  const expected = Uint8Array.from(sha256.create().update(total).digest());

  assertEquals(hex(got), hex(expected));
});

Deno.test("sha256 - matches js-sha256 across many random sizes", async () => {
  for (const size of [0, 1, 31, 64, 128, 4096, 65537, 250_000]) {
    const buf = new Uint8Array(size);
    crypto.getRandomValues(buf.subarray(0, Math.min(size, 65536)));

    const h = await createSha256();
    h.update(buf);
    const got = hex(h.digest());

    const exp = hex(Uint8Array.from(sha256.create().update(buf).digest()));
    assertEquals(got, exp, `mismatch at size ${size}`);
  }
});

Deno.test("sha256 - returns 32 bytes", async () => {
  const h = await createSha256();
  h.update(new Uint8Array(0));
  const out = h.digest();
  assert(out instanceof Uint8Array);
  assertEquals(out.length, 32);
});

Deno.test("sha256 - default backend is auto, native where the runtime has it", () => {
  // nothing in this file changed the backend before this test, so this is
  // the documented default resolved in deno
  assertEquals(getSha256Backend(), "native");
});

// runs fn as if the runtime were a browser or react native: no
// process.getBuiltinModule
async function withoutBuiltins(fn: () => Promise<void>): Promise<void> {
  const p = globalThis.process as unknown as Record<string, unknown>;
  const orig = p.getBuiltinModule;
  p.getBuiltinModule = undefined;
  try {
    await fn();
  } finally {
    p.getBuiltinModule = orig;
    setSha256Backend("js");
    setSha256Backend("auto");
  }
}

Deno.test("sha256 - auto falls back to js without native support", async () => {
  await withoutBuiltins(async () => {
    setSha256Backend("js");
    setSha256Backend("auto");
    assertEquals(getSha256Backend(), "js");
    const data = new TextEncoder().encode("abc");
    const h = await createSha256();
    h.update(data);
    assertEquals(hex(h.digest()), hex(Uint8Array.from(sha256.array(data))));
  });
});

Deno.test("sha256 - native fails where the runtime doesn't have it", async () => {
  await withoutBuiltins(async () => {
    setSha256Backend("native");
    await assertRejects(
      () => createSha256(),
      Error,
      "`node:crypto` is not available",
    );
  });
});

Deno.test("sha256 - native backend matches js backend", async () => {
  const data = new TextEncoder().encode(
    "the quick brown fox jumps over the lazy dog",
  );

  setSha256Backend("js");
  const j = await createSha256();
  j.update(data);
  const jOut = j.digest();

  setSha256Backend("native");
  const n = await createSha256();
  n.update(data);
  const nOut = n.digest();

  assertEquals(jOut.length, 32);
  assertEquals(nOut.length, 32);
  assertEquals(hex(jOut), hex(nOut));

  setSha256Backend("js");
});

Deno.test("sha256 - unknown backend rejected", () => {
  assertThrows(
    () => {
      // deno-lint-ignore no-explicit-any
      setSha256Backend("md5" as any);
    },
    Error,
    "unknown sha256 backend",
  );
});
