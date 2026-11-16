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
  deadline,
  deferred,
  delay,
  errors,
  wsconnect,
  wsUrlParseFn,
} from "../src/internal_mod.ts";
import type { ConnectionOptions, Transport } from "../src/internal_mod.ts";
import type { NatsConnectionImpl } from "../src/nats.ts";
import { WsTransport } from "../src/ws_transport.ts";
import { connect } from "./connect.ts";
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

Deno.test("ws - wsUrlParseFn keeps a given port", () => {
  const cases: [string, boolean | undefined, string][] = [
    // a port that is the default of the other scheme
    ["wss://h:80", undefined, "wss://h:80/"],
    ["tls://h:80", undefined, "wss://h:80/"],
    ["ws://h:443", undefined, "ws://h:443/"],
    ["nats://h:443", undefined, "ws://h:443/"],
    // defaults when no port is given
    ["wss://h", undefined, "wss://h:443/"],
    ["ws://h", undefined, "ws://h:80/"],
    ["wss://h:443", undefined, "wss://h:443/"],
    ["ws://h:80", undefined, "ws://h:80/"],
    // any other scheme is plaintext, and keeps its port
    ["foo://h:1234", undefined, "ws://h:1234/"],
    ["foo://h", undefined, "ws://h:80/"],
    // gossip (the hint is given) is a host:port with the hint's protocol
    ["h:1234", true, "wss://h:1234/"],
    ["h:1234", false, "ws://h:1234/"],
    ["h", true, "wss://h:443/"],
    // an entry's own scheme is dropped
    ["nats://h:4222", true, "wss://h:4222/"],
    ["ws://h:80", true, "wss://h:80/"],
    // bare
    ["h:80", undefined, "wss://h:80/"],
    ["h:443", false, "ws://h:443/"],
    // path and query survive
    ["wss://h:80/nats?x=1", undefined, "wss://h:80/nats?x=1"],
  ];
  for (const [u, encrypted, expect] of cases) {
    assertEquals(wsUrlParseFn(u, encrypted), expect, `${u} ${encrypted}`);
  }
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
  // the connection keeps the factory it was created with, so set it on it
  nc.protocol.transportFactory = {
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
  };

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

// a websocket server that completes the nats handshake, then never reads
// or answers pings
function stalledWsServer(): { port: number; stop: () => void } {
  const listener = Deno.listen({ port: 0, transport: "tcp" });
  const { port } = listener.addr as Deno.NetAddr;
  const connections: Deno.Conn[] = [];
  const TE = new TextEncoder();
  const TD = new TextDecoder();
  const frame = (s: string): Uint8Array => {
    const payload = TE.encode(s);
    // unmasked binary frame, payloads here are < 126 bytes
    return new Uint8Array([0x82, payload.length, ...payload]);
  };
  const unmask = (data: Uint8Array): string => {
    // decodes the masked client frames in data
    let out = "";
    let i = 0;
    while (i + 2 <= data.length) {
      let len = data[i + 1] & 0x7f;
      let off = i + 2;
      if (len === 126) {
        len = (data[off] << 8) | data[off + 1];
        off += 2;
      } else if (len === 127) {
        return out;
      }
      const mask = data.subarray(off, off + 4);
      off += 4;
      const p = data.subarray(off, off + len);
      out += TD.decode(p.map((b, j) => b ^ mask[j % 4]));
      i = off + len;
    }
    return out;
  };
  (async () => {
    for await (const conn of listener) {
      connections.push(conn);
      (async () => {
        const buf = new Uint8Array(4096);
        let req = "";
        while (!req.includes("\r\n\r\n")) {
          const n = await conn.read(buf);
          if (n === null) return;
          req += TD.decode(buf.subarray(0, n));
        }
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(req)![1].trim();
        const digest = await crypto.subtle.digest(
          "SHA-1",
          TE.encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"),
        );
        const accept = btoa(String.fromCharCode(...new Uint8Array(digest)));
        await conn.write(TE.encode(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
            `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        ));
        await conn.write(frame(
          `INFO {"server_id":"stall","version":"2.12.0","proto":1,"max_payload":1048576}\r\n`,
        ));
        let lines = "";
        while (!lines.includes("PING\r\n")) {
          const n = await conn.read(buf);
          if (n === null) return;
          lines += unmask(buf.subarray(0, n));
        }
        await conn.write(frame("PONG\r\n"));
      })().catch(() => {});
    }
  })().catch(() => {});
  return {
    port,
    stop: () => {
      listener.close();
      connections.forEach((c) => {
        try {
          c.close();
        } catch (_) {
          // already closed
        }
      });
    },
  };
}

Deno.test("ws - stale connection to a server that stopped reading", async () => {
  const srv = stalledWsServer();
  const nc = await wsconnect({
    servers: `ws://127.0.0.1:${srv.port}`,
    pingInterval: 250,
    maxPingOut: 2,
    reconnectTimeWait: 100,
  });
  const reconnected = deferred<void>();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === "reconnect") {
        reconnected.resolve();
      }
    }
  })().then();

  // fill the socket so a flush on close never completes
  const payload = new Uint8Array(1024 * 1024);
  for (let i = 0; i < 64; i++) {
    nc.publish("x", payload);
  }

  try {
    await deadline(reconnected, 5000);
  } finally {
    // the reconnected server doesn't read either, so the websocket close
    // handshake can't complete until the server goes away
    srv.stop();
    await nc.close();
  }
});

Deno.test("ws - close on a server that stopped reading", async () => {
  const srv = stalledWsServer();
  const nc = await wsconnect({
    servers: `ws://127.0.0.1:${srv.port}`,
    // between two of the drain checks (every 100ms), so the close times out
    // while one is pending - it must not outlive the close
    closeTimeout: 450,
  } as ConnectionOptions);
  // fill the socket so the close can't drain
  const payload = new Uint8Array(1024 * 1024);
  for (let i = 0; i < 64; i++) {
    nc.publish("x", payload);
  }
  try {
    await deadline(nc.close(), 1500);
  } finally {
    srv.stop();
  }
});

Deno.test("ws - close flushes pending data", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const sub = await wsconnect({ servers: `ws://127.0.0.1:${ns.websocket}` });
  // large messages are written as they are published, the small
  // last one is still in the client's outbound buffer when close() runs
  const N = 129;
  let received = 0;
  const all = deferred<void>();
  sub.subscribe("x", {
    callback: () => {
      if (++received === N) {
        all.resolve();
      }
    },
  });
  await sub.flush();

  const pub = await wsconnect({ servers: `ws://127.0.0.1:${ns.websocket}` });
  const payload = new Uint8Array(512 * 1024);
  for (let i = 0; i < N - 1; i++) {
    pub.publish("x", payload);
  }
  pub.publish("x");
  await pub.close();

  try {
    await deadline(all, 10_000);
  } finally {
    await sub.close();
    await ns.stop();
  }
});

Deno.test("ws - forced reconnect on a server that stopped reading", async () => {
  const srv = stalledWsServer();
  const nc = await wsconnect({
    servers: `ws://127.0.0.1:${srv.port}`,
    pingInterval: 250,
    maxPingOut: 2,
    reconnectTimeWait: 100,
  });
  const reconnected = deferred<void>();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === "reconnect") {
        reconnected.resolve();
      }
    }
  })().then();

  // the close handshake can't complete, the stale connection detected
  // by the heartbeats has to release it
  await nc.reconnect();
  try {
    await deadline(reconnected, 5000);
  } finally {
    srv.stop();
    await nc.close();
  }
});

async function reconnected(nc: NatsConnectionImpl): Promise<void> {
  const done = (async () => {
    for await (const s of nc.status()) {
      if (s.type === "reconnect") {
        return;
      }
    }
  })();
  await nc.reconnect();
  // a connection using the wrong transport never reconnects
  await deadline(done, 5000);
}

Deno.test("ws - a later connect() doesn't change a wsconnect's transport", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const ws = await wsconnect({
    servers: `ws://127.0.0.1:${ns.websocket}`,
  }) as NatsConnectionImpl;
  const tcp = await connect({ port: ns.port }) as NatsConnectionImpl;
  await reconnected(ws);
  assert(ws.protocol.transport instanceof WsTransport);
  await reconnected(tcp);
  assertFalse(tcp.protocol.transport instanceof WsTransport);
  await cleanup(ns, ws, tcp);
});

Deno.test("ws - a later wsconnect() doesn't change a connect's transport", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const tcp = await connect({ port: ns.port }) as NatsConnectionImpl;
  const ws = await wsconnect({
    servers: `ws://127.0.0.1:${ns.websocket}`,
  }) as NatsConnectionImpl;
  await reconnected(tcp);
  assertFalse(tcp.protocol.transport instanceof WsTransport);
  // its server list still parses as tcp, not as ws urls
  tcp.setServers([`127.0.0.1:${ns.port}`]);
  assertEquals(tcp.getServers()[0].src, `127.0.0.1:${ns.port}`);
  await cleanup(ns, ws, tcp);
});

// a websocket to a plain ws server whose url says wss, so a connection can
// run under wssOnly without a tls server
function wssShim(u: string): WebSocket {
  const ws = new WebSocket(u.replace("wss://", "ws://"));
  return new Proxy(ws, {
    get(t, p) {
      if (p === "url") {
        return t.url.replace("ws://", "wss://");
      }
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, p, v) {
      return Reflect.set(t, p, v);
    },
  });
}

Deno.test("ws - wssOnly rejects servers that map to ws", async () => {
  for (const u of ["ws://127.0.0.1:1", "nats://127.0.0.1:1", "http://h:1"]) {
    await assertRejects(
      () => wsconnect({ servers: [u], wssOnly: true }),
      errors.InvalidArgumentError,
      `'wssOnly' requires wss: "${u}" maps to "ws://`,
    );
  }
});

Deno.test("ws - wssOnly refuses a socket that isn't wss", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const err = await assertRejects(() =>
    wsconnect({
      servers: `wss://127.0.0.1:${ns.websocket}`,
      wssOnly: true,
      // a factory that didn't dial the wss url it was given
      wsFactory: (u: string) =>
        Promise.resolve({
          socket: new WebSocket(u.replace("wss://", "ws://")),
        }),
    })
  );
  assert(
    (err as Error).message.includes("'wssOnly' requires wss") ||
      ((err as Error).cause as Error)?.message?.includes(
        "'wssOnly' requires wss",
      ),
    (err as Error).message,
  );
  await ns.stop();
});

Deno.test("ws - wssOnly checks setServers", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    servers: `wss://127.0.0.1:${ns.websocket}`,
    wssOnly: true,
    wsFactory: (u: string) => Promise.resolve({ socket: wssShim(u) }),
  }) as NatsConnectionImpl;
  assert(nc.protocol.transport.isEncrypted());
  const before = nc.getServers().map((s) => s.src);
  let err: Error | undefined;
  try {
    nc.setServers(["wss://h:1", "ws://h:2"]);
  } catch (e) {
    err = e as Error;
  }
  assert(err instanceof errors.InvalidArgumentError);
  assertEquals(nc.getServers().map((s) => s.src), before);
  // bare host:port maps to wss
  nc.setServers(["h:1", "wss://h:2"]);
  assertEquals(nc.getServers().length, 2);
  await cleanup(ns, nc);
});

Deno.test("ws - encrypted comes from the socket's url", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const plain = await wsconnect({
    servers: `ws://127.0.0.1:${ns.websocket}`,
  }) as NatsConnectionImpl;
  assertFalse(plain.protocol.transport.isEncrypted());
  // a factory's socket is judged by its url, not by anything it reports
  const shim = await wsconnect({
    servers: `wss://127.0.0.1:${ns.websocket}`,
    wsFactory: (u: string) =>
      Promise.resolve({ socket: wssShim(u), encrypted: false }),
  }) as NatsConnectionImpl;
  assert(shim.protocol.transport.isEncrypted());
  await plain.close();
  await cleanup(ns, shim);
});

Deno.test("ws - wssOnly null rejects servers that map to wss", async () => {
  for (const u of ["wss://127.0.0.1:1", "tls://127.0.0.1:1", "https://h:1"]) {
    await assertRejects(
      () => wsconnect({ servers: [u], wssOnly: null }),
      errors.InvalidArgumentError,
      `'wssOnly' is null, requires ws: "${u}" maps to "wss://`,
    );
  }
});

Deno.test("ws - wssOnly null dials a plain host:port with ws", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    servers: `127.0.0.1:${ns.websocket}`,
    wssOnly: null,
  }) as NatsConnectionImpl;
  assertFalse(nc.protocol.transport.isEncrypted());
  assert(nc.getServers()[0].src.startsWith("ws://"));
  // setServers: a plain host:port is ws, a wss url is an error
  nc.setServers(["h:1"]);
  assertEquals(nc.getServers()[0].src, "ws://h:1/");
  let err: Error | undefined;
  try {
    nc.setServers(["wss://h:2"]);
  } catch (e) {
    err = e as Error;
  }
  assert(err instanceof errors.InvalidArgumentError);
  assertEquals(nc.getServers()[0].src, "ws://h:1/");
  await cleanup(ns, nc);
});

Deno.test("ws - wssOnly null refuses a socket that is wss", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const err = await assertRejects(() =>
    wsconnect({
      servers: `ws://127.0.0.1:${ns.websocket}`,
      wssOnly: null,
      wsFactory: (u: string) =>
        Promise.resolve({ socket: wssShim(u.replace("ws://", "wss://")) }),
    })
  );
  assert(
    (err as Error).message.includes("'wssOnly' requires ws") ||
      ((err as Error).cause as Error)?.message?.includes(
        "'wssOnly' requires ws",
      ),
    (err as Error).message,
  );
  await ns.stop();
});

Deno.test("ws - wssOnly false is like unset", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    servers: [`ws://127.0.0.1:${ns.websocket}`, "wss://h:1"],
    wssOnly: false,
    noRandomize: true,
  });
  nc.setServers([`ws://127.0.0.1:${ns.websocket}`, "wss://h:1", "h:2"]);
  assertEquals(nc.getServers().length, 3);
  await cleanup(ns, nc);
});

Deno.test("ws - wssOnly must be true, false or null", async () => {
  for (const v of ["true", 1, "null", 0, {}]) {
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => wsconnect({ servers: "ws://127.0.0.1:1", wssOnly: v as any }),
      errors.InvalidArgumentError,
      "'wssOnly' must be true, false or null",
    );
  }
});

Deno.test("ws - wssOnly null keeps a server's url on a listen round trip", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    servers: `ws://127.0.0.1:${ns.websocket}/nats`,
    wssOnly: null,
  }) as NatsConnectionImpl;
  const before = nc.protocol.servers.getServers()[0];
  before.reconnects = 3;
  nc.setServers(nc.getServers().map((s) => s.listen));
  const after = nc.protocol.servers.getServers()[0];
  assertEquals(after, before);
  assertEquals(after.src, `ws://127.0.0.1:${ns.websocket}/nats`);
  assertEquals(after.reconnects, 3);
  await cleanup(ns, nc);
});

Deno.test("ws - wssOnly null makes the port option ws", async () => {
  const ns = await NatsServer.start(wsServerConf());
  const nc = await wsconnect({
    port: ns.websocket,
    wssOnly: null,
  }) as NatsConnectionImpl;
  assertFalse(nc.protocol.transport.isEncrypted());
  assertEquals(nc.getServers()[0].src, `ws://127.0.0.1:${ns.websocket}/`);
  await cleanup(ns, nc);
});

Deno.test("ws - encrypted accepts both tls spellings of the socket url", () => {
  for (
    const [url, encrypted] of [
      ["wss://h:443/", true],
      ["WSS://h:443/", true],
      ["https://h:443/", true],
      ["ws://h:80/", false],
      ["http://h:80/", false],
    ] as [string, boolean][]
  ) {
    const t = new WsTransport();
    // deno-lint-ignore no-explicit-any
    (t as any).socket = { url };
    assertEquals(t.encrypted, encrypted, url);
  }
});
