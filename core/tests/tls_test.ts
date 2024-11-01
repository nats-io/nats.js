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
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { connect } from "./connect.ts";
import { errors } from "../src/internal_mod.ts";
import type { NatsConnectionImpl } from "../src/internal_mod.ts";
import { cleanup, NatsServer } from "test_helpers";

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
  await ns.stop();
  await Deno.remove(tlsConfig.certsDir, { recursive: true });
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
  await ns.stop();
  await Deno.remove(tlsConfig.certsDir, { recursive: true });
});

Deno.test("tls - available connects with or without", async () => {
  const tlsConfig = await NatsServer.tlsConfig();
  const config = {
    host: "0.0.0.0",
    allow_non_tls: true,
    tls: tlsConfig.tls,
  };

  const ns = await NatsServer.start(config);
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
  await Deno.remove(tlsConfig.certsDir, { recursive: true });
});
