/*
 * Copyright 2018-2023 The NATS Authors
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
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  fail,
} from "@std/assert";
import { connect } from "./connect.ts";
import { Lock, NatsServer } from "nst";
import {
  createInbox,
  DataBuffer,
  deadline,
  deferred,
  delay,
  tokenAuthenticator,
} from "../src/internal_mod.ts";
import type { Server } from "../src/internal_mod.ts";
import type { NatsConnectionImpl } from "../src/nats.ts";

import { cleanup, setup } from "nst";
import { ConnectionError } from "../src/errors.ts";

Deno.test("reconnect - should receive when some servers are invalid", async () => {
  const lock = Lock(1);
  const servers = ["127.0.0.1:7", "demo.nats.io:4222"];
  const nc = await connect(
    { servers: servers, noRandomize: true },
  ) as NatsConnectionImpl;
  const subj = createInbox();
  await nc.subscribe(subj, {
    callback: () => {
      lock.unlock();
    },
  });
  nc.publish(subj);
  await lock;
  await nc.close();
  const a = nc.protocol.servers.getServers();
  assertEquals(a.length, 1);
  assert(a[0].didConnect);
});

Deno.test("reconnect - events", async () => {
  const srv = await NatsServer.start();

  const nc = await connect({
    port: srv.port,
    waitOnFirstConnect: true,
    reconnectTimeWait: 100,
    maxReconnectAttempts: 10,
    timeout: 1000,
  });

  let disconnects = 0;
  let reconnecting = 0;

  (async () => {
    for await (const e of nc.status()) {
      switch (e.type) {
        case "disconnect":
          disconnects++;
          break;
        case "reconnecting":
          reconnecting++;
          break;
      }
    }
  })().then();
  await srv.stop();
  const err = await nc.closed();
  assertInstanceOf(err, ConnectionError, "connection closed");
  assertEquals(disconnects, 1);
  assertEquals(reconnecting, 10);
});

Deno.test("reconnect - reconnect not emitted if suppressed", async () => {
  const srv = await NatsServer.start();
  const nc = await connect({
    port: srv.port,
    reconnect: false,
  });

  let disconnects = 0;
  (async () => {
    for await (const e of nc.status()) {
      switch (e.type) {
        case "disconnect":
          disconnects++;
          break;
        case "reconnecting":
          fail("shouldn't have emitted reconnecting");
          break;
      }
    }
  })().then();

  await srv.stop();
  await nc.closed();
});

Deno.test("reconnect - reconnecting after proper delay", async () => {
  const srv = await NatsServer.start();
  const nc = await connect({
    port: srv.port,
    reconnectTimeWait: 500,
    maxReconnectAttempts: 1,
  }) as NatsConnectionImpl;
  const first = nc.protocol.servers.getCurrentServer().lastConnect;

  const dt = deferred<number>();
  (async () => {
    for await (const e of nc.status()) {
      switch (e.type as string) {
        case "reconnecting": {
          const last = nc.protocol.servers.getCurrentServer().lastConnect;
          dt.resolve(last - first);
          break;
        }
      }
    }
  })().then();
  await srv.stop();
  const elapsed = await dt;
  assert(elapsed >= 500 && elapsed <= 800, `elapsed was ${elapsed}`);
  await nc.closed();
});

Deno.test("reconnect - indefinite reconnects", async () => {
  let srv = await NatsServer.start();

  const nc = await connect({
    port: srv.port,
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
          nc.close().then().catch();
          break;
        case "reconnecting":
          reconnects++;
          break;
      }
    }
  })().then();

  await srv.stop();

  const lock = Lock(1);
  setTimeout(async () => {
    srv = await srv.restart();
    lock.unlock();
  }, 1000);

  await nc.closed();
  await srv.stop();
  await lock;
  await srv.stop();
  assert(reconnects >= 5, `${reconnects} >= 5`);
  assert(reconnect);
  assertEquals(disconnects, 1);
});

Deno.test("reconnect - jitter", async () => {
  const srv = await NatsServer.start();

  let called = false;
  const h = () => {
    called = true;
    return 15;
  };

  const dc = await connect({
    port: srv.port,
    reconnect: false,
  }) as NatsConnectionImpl;
  const hasDefaultFn = typeof dc.options.reconnectDelayHandler === "function";

  const nc = await connect({
    port: srv.port,
    maxReconnectAttempts: 1,
    reconnectDelayHandler: h,
  });

  await srv.stop();
  await nc.closed();
  await dc.closed();
  assert(called);
  assert(hasDefaultFn);
});

Deno.test("reconnect - internal disconnect forces reconnect", async () => {
  const srv = await NatsServer.start();
  const nc = await connect({
    port: srv.port,
    reconnect: true,
    reconnectTimeWait: 200,
  }) as NatsConnectionImpl;

  let stale = false;
  let disconnect = false;
  const lock = Lock();
  (async () => {
    for await (const e of nc.status()) {
      switch (e.type) {
        case "staleConnection":
          stale = true;
          break;
        case "disconnect":
          disconnect = true;
          break;
        case "reconnect":
          lock.unlock();
          break;
      }
    }
  })().then();

  nc.protocol.disconnect();
  await lock;

  assert(disconnect, "disconnect");
  assert(stale, "stale");

  await nc.close();
  await srv.stop();
});

Deno.test("reconnect - wait on first connect", async () => {
  let srv = await NatsServer.start({});
  const port = srv.port;
  await delay(500);
  await srv.stop();
  await delay(1000);
  const pnc = connect({
    port: port,
    waitOnFirstConnect: true,
    reconnectTimeWait: 100,
    maxReconnectAttempts: 10,
  });
  await delay(3000);
  srv = await srv.restart();

  const nc = await pnc;
  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      msg.respond();
    },
  });
  await nc.request(subj);

  // stop the server
  await srv.stop();
  // no re will quit the client
  const err = await nc.closed();
  assertInstanceOf(err, ConnectionError, "connection refused");
});

Deno.test("reconnect - close stops reconnects", async () => {
  const { ns, nc } = await setup({}, {
    maxReconnectAttempts: -1,
    reconnectTimeWait: 500,
  });
  const reconnects = deferred();
  (async () => {
    let c = 0;
    for await (const s of nc.status()) {
      if (s.type === "reconnecting") {
        c++;
        if (c === 5) {
          reconnects.resolve();
        }
      }
    }
  })().then();

  setTimeout(() => {
    ns.stop();
  }, 1000);

  await reconnects;
  await deadline(nc.close(), 5000)
    .catch((err) => {
      // the promise will reject if deadline exceeds
      fail(err);
    });
  // await some more, because the close could have a timer pending that
  // didn't complete flapping the test on resource leak
  await delay(1000);
});

Deno.test("reconnect - stale connections don't close", async () => {
  const listener = Deno.listen({ port: 0, transport: "tcp" });
  const { port } = listener.addr as Deno.NetAddr;
  const connections: Deno.Conn[] = [];

  const TE = new TextEncoder();
  const INFO = TE.encode(
    "INFO " + JSON.stringify({
      server_id: "TEST",
      version: "0.0.0",
      host: "127.0.0.1",
      port: port,
    }) + "\r\n",
  );

  const PING = { re: /^PING\r\n/im, out: TE.encode("PONG\r\n") };
  const CONNECT = { re: /^CONNECT\s+([^\r\n]+)\r\n/im, out: TE.encode("") };
  const CMDS = [PING, CONNECT];

  const startReading = (conn: Deno.Conn) => {
    const buf = new Uint8Array(1024 * 8);
    const inbound = new DataBuffer();
    (async () => {
      while (true) {
        const count = await conn.read(buf);
        if (count === null) {
          break;
        }
        if (count) {
          inbound.fill(DataBuffer.concat(buf.subarray(0, count)));
          const lines = DataBuffer.toAscii(inbound.peek());
          for (let i = 0; i < CMDS.length; i++) {
            const m = CMDS[i].re.exec(lines);
            if (m) {
              const len = m[0].length;
              if (len) {
                inbound.drain(len);
                await conn.write(CMDS[i].out);
              }
              if (i === 0) {
                // sent the PONG we are done.
                return;
              }
            }
          }
        }
      }
    })();
  };

  (async () => {
    for await (const conn of listener) {
      connections.push(conn);
      try {
        await conn.write(INFO);
        startReading(conn);
      } catch (_err) {
        console.log(_err);
        return;
      }
    }
  })().then();

  const nc = await connect({
    port,
    maxReconnectAttempts: -1,
    pingInterval: 2000,
    reconnectTimeWait: 500,
    ignoreAuthErrorAbort: true,
    // need a timeout, otherwise the default is 20s and we leak resources
    timeout: 2000,
  });

  let stales = 0;
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === "staleConnection") {
        stales++;
        if (stales === 3) {
          await nc.close();
        }
      }
    }
  })().then();

  await nc.closed();
  listener.close();
  connections.forEach((c) => {
    return c.close();
  });
  assert(stales >= 3, `stales ${stales}`);
  // there could be a redial timer waiting here for 2s
  await delay(2000);
});

Deno.test("reconnect - protocol errors don't close client", async () => {
  const { ns, nc } = await setup({}, {
    maxReconnectAttempts: -1,
    reconnectTimeWait: 500,
  });
  const nci = nc as NatsConnectionImpl;

  let reconnects = 0;
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === "reconnect") {
        reconnects++;
        if (reconnects < 3) {
          setTimeout(() => {
            nci.protocol.sendCommand(`X\r\n`);
          });
        }
        if (reconnects === 3) {
          await nc.close();
        }
      }
    }
  })().then();

  nci.protocol.sendCommand(`X\r\n`);

  const err = await nc.closed();
  assertEquals(err, undefined);

  await cleanup(ns, nc);
});

Deno.test("reconnect - authentication timeout reconnects", async () => {
  const ns = await NatsServer.start({
    authorization: {
      timeout: 0.001,
      token: "hello",
    },
  });

  let counter = 3;
  const authenticator = tokenAuthenticator(() => {
    if (counter-- <= 0) {
      return "hello";
    }
    const start = Date.now();
    while (true) {
      if (Date.now() > start + 150) {
        break;
      }
    }
    return "hello";
  });

  const nc = await connect({
    port: ns.port,
    token: "hello",
    waitOnFirstConnect: true,
    ignoreAuthErrorAbort: true,
    authenticator,
  });

  assert(!nc.isClosed());

  await cleanup(ns, nc);
});

Deno.test("reconnectToServer - handler invoked on initial connect", async () => {
  let calls = 0;
  let lastPoolLen = -1;
  await using ctx = await setup({}, {
    reconnectToServer: (pool) => {
      calls++;
      lastPoolLen = pool.length;
      return pool[0];
    },
  });
  assertEquals(calls, 1);
  assertEquals(lastPoolLen, 1);
  assert(!ctx.nc.isClosed());
  assertEquals(ctx.nc.getServer(), `127.0.0.1:${ctx.ns.port}`);
});

Deno.test("reconnectToServer - returning null uses default", async () => {
  await using ctx = await setup({}, {
    reconnectToServer: () => null,
  });
  assertEquals(ctx.nc.getServer(), `127.0.0.1:${ctx.ns.port}`);
});

Deno.test("reconnectToServer - handler throws rejects connect()", async () => {
  await using ns = await NatsServer.start();
  await assertRejects(
    () =>
      ns.connect({
        reconnectToServer: () => {
          throw new Error("boom");
        },
      }),
    ConnectionError,
    "client option reconnectToServer handler failed: boom",
  );
});

Deno.test("reconnectToServer - out-of-pool rejects connect()", async () => {
  await using ns = await NatsServer.start();
  const fake: Server = {
    hostname: "9.9.9.9",
    port: 9999,
    listen: "9.9.9.9:9999",
    src: "9.9.9.9:9999",
    tlsName: "",
    reconnects: 0,
    lastConnect: 0,
    gossiped: false,
    didConnect: false,
  };
  await assertRejects(
    () => ns.connect({ reconnectToServer: () => fake }),
    ConnectionError,
    "client option reconnectToServer handler failed: returned server is not in the pool",
  );
});

Deno.test("reconnectToServer - throws on reconnect closes connection", async () => {
  await using ns = await NatsServer.start();
  let calls = 0;
  const nc = await ns.connect({
    reconnectTimeWait: 100,
    maxReconnectAttempts: -1,
    reconnectToServer: (pool) => {
      calls++;
      if (calls === 1) return pool[0];
      throw new Error("boom-reconnect");
    },
  });
  await ns.stop();
  const err = await nc.closed();
  assertInstanceOf(err, ConnectionError);
  assertStringIncludes((err as Error).message, "boom-reconnect");
});

Deno.test("reconnectToServer - picks chosen server on reconnect", async () => {
  await using ns0 = await NatsServer.start();
  await using ns1 = await NatsServer.start();
  let firstAttempt = true;
  const nc = await connect({
    servers: [`127.0.0.1:${ns0.port}`, `127.0.0.1:${ns1.port}`],
    noRandomize: true,
    reconnectTimeWait: 100,
    maxReconnectAttempts: -1,
    reconnectToServer: (pool) => {
      if (firstAttempt) {
        firstAttempt = false;
        return pool[0];
      }
      return pool.find((s) => s.port === ns1.port) ?? pool[0];
    },
  });
  assertEquals(nc.getServer(), `127.0.0.1:${ns0.port}`);

  const reconnected = deferred<void>();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === "reconnect") {
        reconnected.resolve();
        break;
      }
    }
  })().then();

  await ns0.stop();
  await reconnected;
  assertEquals(nc.getServer(), `127.0.0.1:${ns1.port}`);
  await nc.close();
});

Deno.test("reconnectToServer - {server, delay} return waits before dial", async () => {
  await using ns = await NatsServer.start();
  const t0 = Date.now();
  let elapsedAtDial = -1;
  const nc = await ns.connect({
    reconnectToServer: (pool) => {
      elapsedAtDial = Date.now() - t0;
      return { server: pool[0], delay: 500 };
    },
  });
  const elapsed = Date.now() - t0;
  assert(elapsed >= 500, `connect elapsed ${elapsed} < 500ms expected delay`);
  assert(
    elapsedAtDial < 500,
    `handler invoked at ${elapsedAtDial}, expected < 500ms`,
  );
  assertEquals(nc.getServer(), `127.0.0.1:${ns.port}`);
  await nc.close();
});

Deno.test("setServers - replaces pool and reconnect dials new pool", async () => {
  await using ns0 = await NatsServer.start();
  await using ns1 = await NatsServer.start();
  const nc = await connect({
    port: ns0.port,
    reconnectTimeWait: 100,
    maxReconnectAttempts: -1,
  });
  assertEquals(nc.getServer(), `127.0.0.1:${ns0.port}`);

  const reconnected = deferred<void>();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === "reconnect") {
        reconnected.resolve();
        break;
      }
    }
  })().then();

  nc.setServers([`127.0.0.1:${ns1.port}`]);
  await nc.reconnect();
  await reconnected;

  assertEquals(nc.getServer(), `127.0.0.1:${ns1.port}`);
  await nc.close();
});
