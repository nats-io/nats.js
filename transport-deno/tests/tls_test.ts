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
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { writeAll } from "@std/io";
import type { NatsConnectionImpl } from "@nats-io/nats-core/internal";
import { delay } from "@nats-io/nats-core/internal";
import { DenoTransport } from "../src/deno_transport.ts";
import { NatsServer } from "./nst.ts";

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

const certs = new URL("../../transport-node/tests/certs/", import.meta.url);
const upgradeCaFile = new URL("ca.pem", certs).pathname;

type UpgradeOpts = {
  tls: boolean;
  first?: string;
  extra?: (idx: number) => string;
  onLine?: (line: string, conn: Deno.Conn, idx: number) => void;
};

// minimal nats server that sends a plaintext info, optionally followed
// by extra bytes, then optionally upgrades to tls. deno can't start tls
// server side on an accepted conn, so the rest of the plaintext conn is
// relayed to a local tls listener.
async function upgradeServer(opts: UpgradeOpts) {
  const cert = await Deno.readTextFile(new URL("server.pem", certs));
  const key = await Deno.readTextFile(new URL("key.pem", certs));
  const received: string[] = [];
  const conns: Deno.Conn[] = [];
  const all: Deno.Conn[] = [];
  let count = 0;
  const plain = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const secure = opts.tls
    ? Deno.listenTls({ hostname: "127.0.0.1", port: 0, cert, key })
    : null;

  const serve = async (conn: Deno.Conn, idx: number) => {
    const te = new TextEncoder();
    const td = new TextDecoder();
    const buf = new Uint8Array(1024 * 64);
    let s = "";
    try {
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        s += td.decode(buf.subarray(0, n));
        let i;
        while ((i = s.indexOf("\r\n")) !== -1) {
          const line = s.slice(0, i);
          s = s.slice(i + 2);
          received.push(line);
          if (line.startsWith("PING")) {
            await writeAll(conn, te.encode("PONG\r\n"));
          }
          opts.onLine?.(line, conn, idx);
        }
      }
    } catch (_) {
      // ignore
    }
  };

  const handle = async (raw: Deno.Conn, idx: number) => {
    all.push(raw);
    const info: Record<string, unknown> = {
      server_id: "FAKE",
      server_name: "fake",
      version: "2.10.0",
      proto: 1,
      max_payload: 1048576,
      headers: true,
    };
    if (opts.tls) {
      info.tls_required = true;
    }
    const extra = opts.extra ? opts.extra(idx) : "";
    const first = opts.first || `INFO ${JSON.stringify(info)}\r\n${extra}`;
    await writeAll(raw, new TextEncoder().encode(first));
    if (!secure) {
      conns[idx] = raw;
      return serve(raw, idx);
    }
    const addr = secure.addr as Deno.NetAddr;
    const up = await Deno.connect({ hostname: addr.hostname, port: addr.port });
    all.push(up);
    const tconn = await secure.accept();
    all.push(tconn);
    conns[idx] = tconn;
    raw.readable.pipeTo(up.writable).catch(() => {});
    up.readable.pipeTo(raw.writable).catch(() => {});
    return serve(tconn, idx);
  };

  (async () => {
    try {
      for await (const c of plain) {
        handle(c, count++).catch(() => {});
      }
    } catch (_) {
      // closed
    }
  })();

  return {
    port: (plain.addr as Deno.NetAddr).port,
    received,
    conns,
    count: () => count,
    close: () => {
      all.forEach((c) => {
        try {
          c.close();
        } catch (_) {
          // ignore
        }
      });
      plain.close();
      secure?.close();
    },
  };
}

Deno.test("tls - ignores plaintext bytes after info", async () => {
  const extra = JSON.stringify({
    server_id: "X",
    server_name: "OTHER",
    version: "2.10.0",
    proto: 1,
    connect_urls: ["other.example.com:4222"],
  });
  const srv = await upgradeServer({
    tls: true,
    extra: () => `INFO ${extra}\r\nPING\r\n`,
  });
  const nc = await connect({
    servers: `127.0.0.1:${srv.port}`,
    tls: { caFile: upgradeCaFile },
  }) as NatsConnectionImpl;
  await nc.flush();
  assertEquals(nc.info?.server_name, "fake");
  const listens = nc.getServers().map((s) => s.listen);
  assert(
    !listens.some((s) => s.includes("other.example.com")),
    `unexpected server in pool: ${listens}`,
  );
  assert(nc.protocol.transport.isEncrypted());
  assert(!srv.received.includes("PONG"), "client answered a ping");
  await nc.close();
  srv.close();
});

// an injected INFO shows up in nc.getServers(), but an injected MSG can only
// be seen by a subscription that would receive it (S21 delivered a forged
// MSG). it has to be a reconnect: on the first connect the subscription
// doesn't exist yet when the injected bytes are parsed, so the MSG would be
// dropped with or without the fix. the server injects it after the plaintext
// INFO of the reconnect, and only the MSG sent over tls must be delivered.
Deno.test("tls - ignores plaintext msg after info on reconnect", async () => {
  const srv = await upgradeServer({
    tls: true,
    extra: (idx) => idx === 0 ? "" : "MSG foo 1 3\r\nbad\r\n",
    onLine: (line, conn, idx) => {
      if (idx > 0 && line.startsWith("SUB foo")) {
        writeAll(conn, new TextEncoder().encode("MSG foo 1 2\r\nok\r\n"))
          .catch(() => {});
      }
    },
  });
  const nc = await connect({
    servers: `127.0.0.1:${srv.port}`,
    tls: { caFile: upgradeCaFile },
    reconnectTimeWait: 100,
  });
  const sub = nc.subscribe("foo", { max: 1 });
  await nc.flush();
  srv.conns[0].close();
  for await (const m of sub) {
    assertEquals(m.string(), "ok");
  }
  assertEquals(srv.count(), 2);
  await nc.close();
  srv.close();
});

Deno.test("tls - plain connection still processes pipelined data", async () => {
  const srv = await upgradeServer({ tls: false, extra: () => "PING\r\n" });
  const nc = await connect({
    servers: `127.0.0.1:${srv.port}`,
  }) as NatsConnectionImpl;
  await nc.flush();
  assertEquals(nc.info?.server_name, "fake");
  assert(!nc.protocol.transport.isEncrypted());
  assert(srv.received.includes("PONG"));
  await nc.close();
  srv.close();
});

Deno.test("tls - rejects non info first op", async () => {
  const srv = await upgradeServer({ tls: false, first: "PING\r\n" });
  await assertRejects(
    () => connect({ servers: `127.0.0.1:${srv.port}`, reconnect: false }),
    Error,
    "unexpected response from server",
  );
  srv.close();
});

// a server that sends a plaintext info asking for tls, then the given
// bytes, and closes the connection - as a full nats-server does
function closingServer(after: string) {
  const plain = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  (async () => {
    for await (const c of plain) {
      const info = JSON.stringify({
        server_id: "FAKE",
        version: "2.10.0",
        proto: 1,
        max_payload: 1048576,
        tls_required: true,
      });
      await writeAll(c, new TextEncoder().encode(`INFO ${info}\r\n${after}`))
        .catch(() => {});
      c.close();
    }
  })().catch(() => {});
  return {
    port: (plain.addr as Deno.NetAddr).port,
    close: () => plain.close(),
  };
}

Deno.test("tls - failed upgrade quotes the dropped line", async () => {
  const srv = closingServer("-ERR 'maximum connections exceeded'\r\n");
  const err = await assertRejects(() =>
    connect({
      servers: `127.0.0.1:${srv.port}`,
      tls: { caFile: upgradeCaFile },
      reconnect: false,
    })
  ) as Error;
  assert(err.message.includes("(untrusted)"), err.message);
  assert(
    err.message.endsWith(`"-ERR 'maximum connections exceeded'"`),
    err.message,
  );
  srv.close();
});

Deno.test("tls - failed upgrade without dropped bytes keeps the error", async () => {
  const srv = closingServer("");
  const err = await assertRejects(() =>
    connect({
      servers: `127.0.0.1:${srv.port}`,
      tls: { caFile: upgradeCaFile },
      reconnect: false,
    })
  ) as Error;
  assert(!err.message.includes("(untrusted)"), err.message);
  srv.close();
});

Deno.test("tls - cleartext info doesn't replace the discovered servers", async () => {
  const info = (urls: string[]) =>
    `INFO ${
      JSON.stringify({
        server_id: "FAKE",
        server_name: "fake",
        version: "2.10.0",
        proto: 1,
        max_payload: 1048576,
        tls_required: true,
        connect_urls: urls,
      })
    }\r\n`;
  // connect_urls in the cleartext info are unauthenticated
  const srv = await upgradeServer({
    tls: true,
    first: info(["cleartext.example.com:4222"]),
  });
  const nc = await connect({
    servers: `127.0.0.1:${srv.port}`,
    tls: { caFile: upgradeCaFile },
  });
  await nc.flush();
  const listens = () => nc.getServers().map((s) => s.listen);
  assert(
    !listens().some((s) => s.startsWith("cleartext.example.com")),
    `server from the cleartext info in pool: ${listens()}`,
  );
  // and they are cleared from the info the client keeps
  assertEquals(nc.info?.connect_urls, undefined);

  // an info received over tls is applied
  await writeAll(
    srv.conns[0],
    new TextEncoder().encode(info(["tls.example.com:4222"])),
  );
  for (let i = 0; i < 40 && !listens().some((s) => s.startsWith("tls.")); i++) {
    await delay(50);
  }
  assert(
    listens().some((s) => s.startsWith("tls.example.com")),
    `server from the tls info missing: ${listens()}`,
  );
  await nc.close();
  srv.close();
});

// tls first: the name verified is the inherited tls name, not the address
// dialed. the server certificate has only DNS:localhost
async function tlsFirstServer() {
  const certs = (f: string) =>
    fromFileUrl(
      new URL(`../../transport-node/tests/certs/${f}`, import.meta.url),
    );
  const ns = await NatsServer.start({
    host: "127.0.0.1",
    tls: {
      handshake_first: true,
      cert_file: certs("server_noip.pem"),
      key_file: certs("key_noip.pem"),
      ca_file: certs("ca.pem"),
    },
  });
  return { ns, ca: certs("ca.pem") };
}

Deno.test("tls - tls first verifies against the inherited name", async () => {
  const { ns, ca } = await tlsFirstServer();
  const t = new DenoTransport();
  await t.connect(
    { hostname: "127.0.0.1", port: ns.port, tlsName: "localhost" },
    { tls: { handshakeFirst: true, caFile: ca } },
  );
  assert(t.isEncrypted());
  await t.close();
  await ns.stop();
});

Deno.test("tls - tls first without an inherited name verifies the host", async () => {
  const { ns, ca } = await tlsFirstServer();
  for (const tlsName of ["", "nats.example.com"]) {
    const t = new DenoTransport();
    await assertRejects(() =>
      t.connect(
        { hostname: "127.0.0.1", port: ns.port, tlsName },
        { tls: { handshakeFirst: true, caFile: ca } },
      )
    );
  }
  await ns.stop();
});
