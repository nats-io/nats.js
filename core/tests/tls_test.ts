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
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connect } from "./connect.ts";
import { errors } from "../src/internal_mod.ts";
import type { NatsConnectionImpl } from "../src/internal_mod.ts";
import { dialError } from "../src/protocol.ts";
import { cleanup, NatsServer } from "nst";

Deno.test("tls - fail if server doesn't support TLS", async () => {
  const ns = await NatsServer.start();
  await assertRejects(
    () => {
      return connect({ port: ns.port, tls: {}, reconnect: false });
    },
    errors.ConnectionError,
    "server does not support 'tls'",
  );
  await ns.stop();
});

Deno.test("tls - connects to tls without option", async () => {
  const nc = await connect({ servers: "demo.nats.io" }) as NatsConnectionImpl;
  await nc.flush();
  assertEquals(nc.protocol.transport.isEncrypted(), true);
  await nc.close();
});

Deno.test("tls - custom ca fails without root", async () => {
  const tlsConfig = await NatsServer.tlsConfig();
  const config = {
    host: "0.0.0.0",
    tls: tlsConfig.tls,
  };

  const ns = await NatsServer.start(config);
  await assertRejects(
    () => {
      return connect({ servers: `localhost:${ns.port}`, reconnect: false });
    },
    errors.ConnectionError,
    "invalid peer certificate: unknownissuer",
  );
  ns.certsDir = tlsConfig.certsDir;
  await ns.stop(true);
});

Deno.test("tls - custom ca with root connects", async () => {
  const tlsConfig = await NatsServer.tlsConfig();
  const config = {
    host: "0.0.0.0",
    tls: tlsConfig.tls,
  };

  const ns = await NatsServer.start(config);
  const nc = await connect({
    servers: `localhost:${ns.port}`,
    tls: {
      caFile: config.tls.ca_file,
    },
  });
  await nc.flush();
  await nc.close();
  ns.certsDir = tlsConfig.certsDir;
  await ns.stop(true);
});

Deno.test("tls - available connects with or without", async () => {
  const tlsConfig = await NatsServer.tlsConfig();
  const config = {
    host: "0.0.0.0",
    allow_non_tls: true,
    tls: tlsConfig.tls,
  };

  const ns = await NatsServer.start(config);
  ns.certsDir = tlsConfig.certsDir;
  // will upgrade to tls but fail in the test because the
  // certificate will not be trusted
  await assertRejects(async () => {
    await connect({
      servers: `localhost:${ns.port}`,
    });
  });

  // will upgrade to tls as tls is required
  const a = connect({
    servers: `localhost:${ns.port}`,
    tls: {
      caFile: config.tls.ca_file,
    },
  });
  // will NOT upgrade to tls
  const b = connect({
    servers: `localhost:${ns.port}`,
    tls: null,
  });
  const conns = await Promise.all([a, b]) as NatsConnectionImpl[];
  await conns[0].flush();
  await conns[1].flush();

  assertEquals(conns[0].protocol.transport.isEncrypted(), true);
  assertEquals(conns[1].protocol.transport.isEncrypted(), false);

  await cleanup(ns, ...conns);
});

Deno.test("tls - a configured name with a trailing dot connects", async () => {
  const tlsConfig = await NatsServer.tlsConfig();
  const config = { host: "127.0.0.1", tls: tlsConfig.tls };
  const ns = await NatsServer.start(config);
  // sni can't carry the dot, nats-server refuses a handshake with it
  const nc = await connect({
    servers: `localhost.:${ns.port}`,
    tls: { caFile: config.tls.ca_file },
  });
  await nc.flush();
  await nc.close();
  ns.certsDir = tlsConfig.certsDir;
  await ns.stop(true);
});

Deno.test("tls - null refuses a server that requires tls", async () => {
  const tlsConfig = await NatsServer.tlsConfig();
  const ns = await NatsServer.start({ host: "127.0.0.1", tls: tlsConfig.tls });
  await assertRejects(
    () =>
      connect({
        servers: `127.0.0.1:${ns.port}`,
        tls: null,
        reconnect: false,
      }),
    errors.ConnectionError,
    "client disabled tls ('tls: null'), but server requires tls",
  );
  ns.certsDir = tlsConfig.certsDir;
  await ns.stop(true);
});

Deno.test("tls - null refusal is reported when localhost has other addresses", async () => {
  // localhost is ::1 and 127.0.0.1, tried in random order: ::1 is refused,
  // 127.0.0.1 refuses for tls. the refusal is the error every time
  const tlsConfig = await NatsServer.tlsConfig();
  const ns = await NatsServer.start({ host: "127.0.0.1", tls: tlsConfig.tls });
  for (let i = 0; i < 10; i++) {
    const err = await assertRejects(
      () =>
        connect({
          servers: `localhost:${ns.port}`,
          tls: null,
          reconnect: false,
        }),
      errors.ConnectionError,
      "client disabled tls ('tls: null'), but server requires tls",
    );
    // the other addresses' errors are chained, and it serializes
    JSON.stringify(err);
    const others = (err as Error & { errors?: { server: string }[] }).errors;
    if (others) {
      assert(others.every((o) => o.server !== `127.0.0.1:${ns.port}`));
    }
  }
  ns.certsDir = tlsConfig.certsDir;
  await ns.stop(true);
});

Deno.test("tls - dialError prefers a reason over a refused dial", () => {
  const refused = new errors.ConnectionError("connection refused");
  const reason = new errors.ConnectionError("a reason");
  for (
    const failed of [
      [{ server: "::1:1", error: refused }, {
        server: "127.0.0.1:1",
        error: reason,
      }],
      [{ server: "127.0.0.1:1", error: reason }, {
        server: "::1:1",
        error: refused,
      }],
    ]
  ) {
    const err = dialError(failed, failed[1].error)!;
    assertEquals(err, reason);
    assertEquals(
      (err as Error & { errors: unknown[] }).errors,
      [{ server: "::1:1", error: refused }],
    );
    JSON.stringify(err);
  }

  // every address refused: the last error, with the others chained
  const r2 = new errors.ConnectionError("connection refused (os error 61)");
  const err = dialError(
    [{ server: "::1:1", error: refused }, { server: "127.0.0.1:1", error: r2 }],
    r2,
  )!;
  assertEquals(err, r2);
  assertEquals((err as Error & { errors: unknown[] }).errors.length, 1);

  // one address: as it was
  const one = new errors.ConnectionError("connection refused");
  assertEquals(dialError([{ server: "h:1", error: one }], one), one);
  assertEquals(
    (one as Error & { errors?: unknown[] }).errors,
    undefined,
  );

  // an error that isn't a dial's, such as a waitOnFirstConnect callback that
  // threw, is reported as it is
  const cb = new Error("callback");
  assertEquals(
    dialError([{ server: "::1:1", error: refused }, {
      server: "h:1",
      error: reason,
    }], cb),
    cb,
  );
});
