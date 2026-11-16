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
import { connect } from "../src/mod.ts";
import type { ConnectionOptions } from "@nats-io/nats-core";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

// fake server that sends a plaintext INFO and records the first bytes
// the client writes back, then drops the connection.
async function firstBytes(
  info: Record<string, unknown>,
  opts: ConnectionOptions,
): Promise<{ ok: boolean; data: Uint8Array }> {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  const first = (async () => {
    const c = await l.accept();
    const info2 = Object.assign({
      server_id: "fake",
      version: "2.10.0",
      proto: 1,
      max_payload: 1024 * 1024,
      host: "127.0.0.1",
    }, info);
    await c.write(
      new TextEncoder().encode(`INFO ${JSON.stringify(info2)}\r\n`),
    );
    const buf = new Uint8Array(4096);
    const n = await c.read(buf);
    try {
      c.close();
    } catch (_) {
      // ignore
    }
    return buf.subarray(0, n ?? 0);
  })();

  const ok = await connect(
    Object.assign({ servers: `127.0.0.1:${port}`, reconnect: false }, opts),
  ).then(
    (nc) => nc.close().then(() => true),
    () => false,
  );
  const data = await first;
  l.close();
  return { ok, data };
}

function assertTlsAttempt(data: Uint8Array) {
  assertEquals(data[0], 0x16, "expected a tls handshake record");
  assertEquals(new TextDecoder().decode(data).indexOf("CONNECT"), -1);
}

function assertPlainConnect(data: Uint8Array) {
  assert(new TextDecoder().decode(data).startsWith("CONNECT"));
}

const caFile = fromFileUrl(
  new URL("../../core/tests/certs/RootCA.crt", import.meta.url),
);
const creds = { user: "u", pass: "p" };

for (const v of [1, "true", {}]) {
  for (const tls of [{}, { caFile }]) {
    const tn = "caFile" in tls ? "{caFile}" : "{}";
    Deno.test(
      `tls - option makes tls mandatory tls_available=${
        JSON.stringify(v)
      } tls=${tn}`,
      async () => {
        const { ok, data } = await firstBytes(
          { tls_available: v },
          Object.assign({ tls }, creds),
        );
        assertEquals(ok, false);
        assertTlsAttempt(data);
      },
    );
  }
}

Deno.test("tls - option makes tls mandatory tls_required=false", async () => {
  const { ok, data } = await firstBytes(
    { tls_required: false, tls_available: 1 },
    Object.assign({ tls: {} }, creds),
  );
  assertEquals(ok, false);
  assertTlsAttempt(data);
});

Deno.test("tls - option makes tls mandatory handshakeFirst=1", async () => {
  const { ok, data } = await firstBytes(
    { tls_available: 1 },
    // deno-lint-ignore no-explicit-any
    Object.assign({ tls: { handshakeFirst: 1 as any } }, creds),
  );
  assertEquals(ok, false);
  assertTlsAttempt(data);
});

Deno.test("tls - tls_required=1 without tls option upgrades", async () => {
  const { data } = await firstBytes({ tls_required: 1 }, creds);
  assertTlsAttempt(data);
});

Deno.test("tls - tls_available=true with tls option upgrades", async () => {
  const { ok, data } = await firstBytes(
    { tls_available: true },
    Object.assign({ tls: {} }, creds),
  );
  assertEquals(ok, false);
  assertTlsAttempt(data);
});

Deno.test("tls - tls_available=true without tls option upgrades", async () => {
  const { data } = await firstBytes({ tls_available: true }, creds);
  assertTlsAttempt(data);
});

Deno.test("tls - tls_available=1 without tls option unchanged", async () => {
  const { data } = await firstBytes({ tls_available: 1 }, creds);
  assertPlainConnect(data);
});

Deno.test("tls - tls null with tls_available=true unchanged", async () => {
  const { data } = await firstBytes(
    { tls_available: true },
    Object.assign({ tls: null }, creds),
  );
  assertPlainConnect(data);
});
