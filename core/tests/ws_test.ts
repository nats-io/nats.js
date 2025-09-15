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
  errors,
  wsconnect,
  wsUrlParseFn,
} from "../src/internal_mod.ts";
import type { NatsConnectionImpl } from "../src/nats.ts";
import {
  assertBetween,
  cleanup,
  Lock,
  NatsServer,
  wsServerConf,
} from "test_helpers";

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
