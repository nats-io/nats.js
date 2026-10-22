/*
 * Copyright 2024 The NATS Authors
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
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertRejects,
} from "@std/assert";

import {
  createInbox,
  deferred,
  delay,
  errors,
  setTransportFactory,
  wsconnect,
  wsUrlParseFn,
} from "../src/internal_mod.ts";
import type { Transport } from "../src/internal_mod.ts";
import type { NatsConnectionImpl } from "../src/nats.ts";
import { WsTransport } from "../src/ws_transport.ts";
import { assertBetween, cleanup, Lock, NatsServer, wsServerConf } from "nst";

Deno.test("ws - connect", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({ servers: `ws://127.0.0.1:${ns.websocket}` });
  await nc.flush();
  await cleanup(ns, nc);
});

// Fixme: allow sanitizer once ws transport closes cleanly.

Deno.test("ws - wss connection", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    servers: `wss://demo.nats.io:8443`,
  });
  assertEquals(
    (nc as NatsConnectionImpl).protocol.transport?.isEncrypted(),
    true,
  );
  await nc.flush();
  await cleanup(ns, nc);
});

Deno.test(
  "ws - pubsub",
  async () => {
    const ns = await NatsServer.start(wsServerConf());
    const nc = await wsconnect({ servers: `ws://127.0.0.1:${ns.websocket}` });

    const sub = nc.subscribe(createInbox());
    const done = (async () => {
      for await (const m of sub) {
        return m;
      }
    })().then();
    nc.publish(sub.getSubject(), "hello world");
    const r = await done;
    assertExists(r);
    assertEquals(r.subject, sub.getSubject());
    assertEquals(r.string(), "hello world");
    await cleanup(ns, nc);
  },
);

Deno.test(
  "ws - disconnect reconnects",
  async () => {
    const ns = await NatsServer.start(wsServerConf());

    const nc = await wsconnect({ servers: `ws://127.0.0.1:${ns.websocket}` });

    const status = nc.status();
    const done = (async () => {
      for await (const s of status) {
        switch (s.type) {
          case "reconnect":
            return;
          default:
        }
      }
    })();

    await nc.reconnect();
    await done;
    await cleanup(ns, nc);
  },
);

Deno.test("ws - tls options are not supported", async () => {
  await assertRejects(
    () => {
      return wsconnect({ servers: "wss://demo.nats.io:8443", tls: {} });
    },
    errors.InvalidArgumentError,
    "'tls' is not configurable on w3c websocket connections",
  );
});

Deno.test(
  "ws - indefinite reconnects",
  async () => {
    let ns = await NatsServer.start(wsServerConf());
    const nc = await wsconnect({
      servers: `ws://127.0.0.1:${ns.websocket}`,
      reconnectTimeWait: 100,
      maxReconnectAttempts: -1,
    });

    let disconnects = 0;
    let reconnects = 0;
    let reconnect = false;
    (async () => {
      for await (const e of nc.status()) {
        switch (e.type) {
          case "disconnect":
            disconnects++;
            break;
          case "reconnect":
            reconnect = true;
            nc.close();
            break;
          case "reconnecting":
            reconnects++;
            break;
        }
      }
    })().then();

    await ns.stop();

    const lock = Lock(1);
    setTimeout(async () => {
      ns = await ns.restart();
      lock.unlock();
    }, 1000);

    await nc.closed();
    await ns.stop();
    await lock;
    await ns.stop();
    assertBetween(reconnects, 4, 10);
    assert(reconnect);
    assert(disconnects >= 1);
  },
);

Deno.test("ws - basics", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    servers: `ws://127.0.0.1:${ns.websocket}`,
  }) as NatsConnectionImpl;

  const t = nc.protocol.transport;
  assertFalse(t.isClosed);
  await nc.close();
  assertEquals(t.isClosed, true);
  await ns.stop();
});

Deno.test("ws - url parse", () => {
  const u = [
    { in: "foo", expect: "wss://foo:443/" },
    { in: "foo:100", expect: "wss://foo:100/" },
    { in: "foo/", expect: "wss://foo:443/" },
    { in: "foo/hello", expect: "wss://foo:443/hello" },
    { in: "foo:100/hello", expect: "wss://foo:100/hello" },
    { in: "foo/hello?one=two", expect: "wss://foo:443/hello?one=two" },
    { in: "foo:100/hello?one=two", expect: "wss://foo:100/hello?one=two" },
    { in: "nats://foo", expect: "ws://foo:80/" },
    { in: "tls://foo", expect: "wss://foo:443/" },
    { in: "ws://foo", expect: "ws://foo:80/" },
    { in: "ws://foo:100", expect: "ws://foo:100/" },
    {
      in: "[2001:db8:1f70::999:de8:7648:6e8]",
      expect: "wss://[2001:db8:1f70:0:999:de8:7648:6e8]:443/",
    },
    {
      in: "[2001:db8:1f70::999:de8:7648:6e8]:100",
      expect: "wss://[2001:db8:1f70:0:999:de8:7648:6e8]:100/",
    },
  ];

  u.forEach((tc) => {
    const out = wsUrlParseFn(tc.in);
    assertEquals(out, tc.expect, `test ${tc.in}`);
  });
});

Deno.test("ws - wsURLParseFn", () => {
  assertEquals(wsUrlParseFn("localhost", true), "wss://localhost:443/");
  assertEquals(wsUrlParseFn("localhost", false), "ws://localhost:80/");
  assertEquals(wsUrlParseFn("http://localhost"), "ws://localhost:80/");
  assertEquals(wsUrlParseFn("https://localhost"), "wss://localhost:443/");
});

Deno.test("ws - reconnectToServer invoked on initial connect", async () => {
  const ns = await NatsServer.start(wsServerConf());
  let calls = 0;
  let lastPoolLen = -1;
  const nc = await wsconnect({
    servers: `ws://127.0.0.1:${ns.websocket}`,
    reconnectToServer: (pool) => {
      calls++;
      lastPoolLen = pool.length;
      return pool[0];
    },
  });
  assertEquals(calls, 1);
  assertEquals(lastPoolLen, 1);
  await cleanup(ns, nc);
});

Deno.test("ws - getServers returns ws listens", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    servers: `ws://127.0.0.1:${ns.websocket}`,
  });
  const servers = nc.getServers();
  assert(servers.length >= 1);
  const listens = servers.map((s) => s.listen);
  assert(
    listens.some((l) => l.includes(`${ns.websocket}`)),
    `expected ws port in listens: ${listens.join(",")}`,
  );
  await cleanup(ns, nc);
});

Deno.test("ws - setServers replaces pool and reconnect dials new", async () => {
  const ns0 = await NatsServer.start(wsServerConf());
  const ns1 = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    servers: `ws://127.0.0.1:${ns0.websocket}`,
    reconnectTimeWait: 100,
    maxReconnectAttempts: -1,
  }) as NatsConnectionImpl;
  assert(nc.getServer().includes(`${ns0.websocket}`));

  const reconnected = deferred<void>();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === "reconnect") {
        reconnected.resolve();
        break;
      }
    }
  })().then();

  nc.setServers([`ws://127.0.0.1:${ns1.websocket}`]);
  await nc.reconnect();
  await reconnected;

  assert(
    nc.getServer().includes(`${ns1.websocket}`),
    `expected ${ns1.websocket}, got ${nc.getServer()}`,
  );
  await nc.close();
  await ns0.stop();
  await ns1.stop();
});

Deno.test("ws - outage emits one disconnect and one reconnect", async () => {
  let ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    servers: `ws://127.0.0.1:${ns.websocket}`,
    reconnectTimeWait: 100,
    maxReconnectAttempts: -1,
  });

  const events: string[] = [];
  const reconnected = deferred<void>();
  (async () => {
    for await (const s of nc.status()) {
      events.push(s.type);
      if (s.type === "reconnect") {
        reconnected.resolve();
      }
    }
  })().then();

  await ns.stop();
  // let a number of dial attempts fail
  await delay(2000);
  ns = await ns.restart();
  await reconnected;
  // allow any stray status from failed attempts to arrive
  await delay(1000);

  const count = (t: string) => events.filter((e) => e === t).length;
  assertEquals(count("disconnect"), 1, events.join(","));
  assertEquals(count("reconnect"), 1, events.join(","));
  assert(count("reconnecting") > 1, events.join(","));

  await nc.close();
  await ns.stop();
});

Deno.test("ws - late close of a stale transport is ignored", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    servers: `ws://127.0.0.1:${ns.websocket}`,
    reconnectTimeWait: 100,
    maxReconnectAttempts: -1,
    timeout: 500,
  }) as NatsConnectionImpl;

  // the next dial gets a transport whose connect hangs (dial times out)
  // and whose closed() only resolves when the test says so - simulating
  // an abandoned handshake that closes after the client reconnected
  const staleClosed = deferred<void | Error>();
  let dials = 0;
  setTransportFactory({
    defaultPort: 443,
    urlParseFn: wsUrlParseFn,
    factory: (): Transport => {
      dials++;
      if (dials > 1) {
        return new WsTransport();
      }
      return {
        isClosed: false,
        lang: "nats.ws",
        version: "test",
        closeError: undefined,
        connect: () => new Promise<void>(() => {}),
        [Symbol.asyncIterator]: () => {
          throw new Error("not connected");
        },
        isEncrypted: () => false,
        send: () => {},
        close: () => Promise.resolve(),
        disconnect: () => {},
        closed: () => staleClosed,
        discard: () => {},
      } as unknown as Transport;
    },
  });

  const events: string[] = [];
  const reconnected = deferred<void>();
  (async () => {
    for await (const s of nc.status()) {
      events.push(s.type);
      if (s.type === "reconnect") {
        reconnected.resolve();
      }
    }
  })().then();

  await nc.reconnect();
  await reconnected;
  assert(dials >= 2);
  const current = nc.protocol.transport;

  // the stale transport closes late
  staleClosed.resolve();
  await delay(1000);

  const count = (t: string) => events.filter((e) => e === t).length;
  assertEquals(count("disconnect"), 1, events.join(","));
  assertEquals(count("reconnect"), 1, events.join(","));
  assertEquals(nc.protocol.transport, current);
  assertFalse(current.isClosed);
  await nc.flush();

  await nc.close();
  await ns.stop();
});
