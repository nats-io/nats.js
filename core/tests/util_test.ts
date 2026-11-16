/*
 * Copyright 2023 The NATS Authors
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
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  backoff,
  deadline,
  debugDeferred,
  deferred,
  MAX_QUOTED_LINE,
  millis,
  nanos,
  quoteServerLine,
  randomToken,
  SimpleMutex,
  tlsUpgradeError,
} from "../src/util.ts";
import { ConnectionError, TimeoutError } from "../src/errors.ts";

Deno.test("util - simple mutex", () => {
  const r = new SimpleMutex(1);
  assertEquals(r.max, 1);
  assertEquals(r.current, 0);

  r.lock().catch();
  assertEquals(r.current, 1);

  r.lock().catch();
  assertEquals(r.current, 2);
  assertEquals(r.waiting.length, 1);

  r.unlock();
  assertEquals(r.current, 1);
  assertEquals(r.waiting.length, 0);
});

Deno.test("util - backoff", () => {
  const b = backoff([0, 100, 200]);
  assertEquals(b.backoff(0), 0);
  let n = b.backoff(1);
  assert(n >= 50 && 150 >= n, `${n} >= 50 && 150 >= ${n}`);
  n = b.backoff(2);
  assert(n >= 100 && 300 >= n, `${n} >= 100 && 300 >= ${n}`);
  n = b.backoff(3);
  assert(n >= 100 && 300 >= n, `${n} >= 100 && 300 >= ${n}`);
});

Deno.test("util - deadline", async () => {
  await assertRejects(() => {
    return deadline(deferred(), 100);
  }, TimeoutError);
});

Deno.test("util - nanos", () => {
  assertEquals(nanos(1000), 1000000000);
  assertEquals(millis(1000000000), 1000);
});

Deno.test("util - backoff bad arg", () => {
  //@ts-expect-error: test
  const b = backoff("hello");
  assert(b.backoff(1) > 0);
});

Deno.test("util - debug deferred", async () => {
  await assertRejects(() => {
    const d = debugDeferred();
    d.reject("hello world");
    return d;
  });
});

Deno.test("util - randomToken shape", () => {
  // Must be exactly 8 chars, all in [0-9A-Za-z]. No '.' (would break the
  // `_INBOX.<nuid>.*` mux subscription's single-token wildcard match).
  const re = /^[0-9A-Za-z]{8}$/;
  for (let i = 0; i < 1000; i++) {
    const t = randomToken();
    assertEquals(t.length, 8);
    assert(re.test(t), `bad token: ${JSON.stringify(t)}`);
  }
});

Deno.test("util - randomToken uniqueness", () => {
  // 62^8 ≈ 2.18e14 space; 10k draws should produce ~zero collisions.
  const seen = new Set<string>();
  for (let i = 0; i < 10000; i++) seen.add(randomToken());
  assert(seen.size > 9990, `near-unique expected, got ${seen.size}/10000`);
});

Deno.test("util - quote server line", () => {
  const te = new TextEncoder();
  const q = (s: string) => quoteServerLine(te.encode(s));
  // only the first line, without its line ending
  assertEquals(
    q("-ERR 'maximum connections exceeded'\r\nPING\r\n"),
    `"-ERR 'maximum connections exceeded'"`,
  );
  assertEquals(q("no line ending"), `"no line ending"`);
  // control characters and terminal escapes are escaped
  assertEquals(
    q("a\tb\x1b[31mred\x00\x7f\u009b\r\n"),
    `"a\\tb\\x1b[31mred\\x00\\x7f\\x9b"`,
  );
  // a lone cr inside the line is escaped too
  assertEquals(q("a\rb\n"), `"a\\rb"`);
  // quotes and backslashes can't fake the end of the quote
  assertEquals(q(`a"b\\"c`), `"a\\"b\\\\\\"c"`);
  // cut at MAX_QUOTED_LINE bytes
  const long = "x".repeat(MAX_QUOTED_LINE + 100);
  assertEquals(q(long), `"${"x".repeat(MAX_QUOTED_LINE)}"...`);
  assertEquals(
    q("x".repeat(MAX_QUOTED_LINE)),
    `"${"x".repeat(MAX_QUOTED_LINE)}"`,
  );
});

Deno.test("util - tls upgrade error", () => {
  const cause = new Error("handshake failed");
  // nothing was dropped - the error is unchanged
  assertEquals(tlsUpgradeError(cause, new Uint8Array(0)), cause);
  const err = tlsUpgradeError(
    cause,
    new TextEncoder().encode("-ERR 'maximum connections exceeded'\r\n"),
  );
  assert(err instanceof ConnectionError);
  assertEquals(err.cause, cause);
  assert(err.message.includes("(untrusted)"), err.message);
  assert(
    err.message.endsWith(`"-ERR 'maximum connections exceeded'"`),
    err.message,
  );
});
