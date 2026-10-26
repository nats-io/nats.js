/*
 * Copyright 2018-2024 The NATS Authors
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
const { describe, it } = require("node:test");
const assert = require("node:assert").strict;
const {
  connect,
  wsconnect,
} = require("../index");
const { NatsServer } = require("@nats-io/nst");
const {
  createInbox,
  deferred,
  delay,
} = require("@nats-io/nats-core/internal");
const { Lock } = require("@nats-io/nst");
const net = require("node:net");

describe("websocket reconnect", { timeout: 20_000, forceExit: true }, () => {
  it("reconnect websocket - disconnect reconnects", async () => {
    let srv = await NatsServer.start({
      logfile: "/tmp/nats-server.log",
      websocket: {
        port: -1,
        no_tls: true,
      },
    });

    const d = deferred();
    const nc = await wsconnect({
      debug: true,
      servers: [`ws://127.0.0.1:${srv.websocket}`],
    });

    const port = srv.websocket;
    (async () => {
      for await (const e of nc.status()) {
        if (e.type === "reconnect") {
          d.resolve();
        }
      }
    })();

    await delay(1000);
    await srv.stop();
    srv = await NatsServer.start({
      websocket: {
        port,
        no_tls: true,
      },
    });

    await d;
    await nc.close();
    await srv.stop();
  });
});

describe(
  "reconnect",
  { timeout: 20_000, concurrency: true, forceExit: true },
  () => {
    it("reconnect - should receive when some servers are invalid", async () => {
      const lock = Lock(1);
      const servers = ["127.0.0.1:7", "demo.nats.io:4222"];
      const nc = await connect({ servers: servers, noRandomize: true });
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
      assert.equal(a.length, 1);
      assert.ok(a[0].didConnect);
    });

    it("reconnect - events", async () => {
      const srv = await NatsServer.start();

      const nc = await connect({
        port: srv.port,
        waitOnFirstConnect: true,
        reconnectTimeWait: 100,
        maxReconnectAttempts: 10,
      });

      let disconnects = 0;
      let reconnecting = 0;

      const status = nc.status();
      (async () => {
        for await (const e of status) {
          switch (e.type) {
            case "disconnect":
              disconnects++;
              break;
            case "reconnecting":
              reconnecting++;
              break;
            default:
              t.log(e);
          }
        }
      })().then();
      await srv.stop();
      try {
        await nc.closed();
      } catch (err) {
        assert.equal(err.message, "connection refused");
      }
      assert.equal(disconnects, 1, "disconnects");
      assert.equal(reconnecting, 10, "reconnecting");
    });

    it("reconnect - reconnect not emitted if suppressed", async () => {
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
              t.fail("shouldn't have emitted reconnecting");
              break;
          }
        }
      })().then();

      await srv.stop();
      await nc.closed();
    });

    it("reconnect - reconnecting after proper delay", async () => {
      const srv = await NatsServer.start();
      const nc = await connect({
        port: srv.port,
        reconnectTimeWait: 500,
        maxReconnectAttempts: 1,
      });

      const serverLastConnect =
        nc.protocol.servers.getCurrentServer().lastConnect;

      const dt = deferred();
      (async () => {
        for await (const e of nc.status()) {
          switch (e.type) {
            case "reconnecting":
              dt.resolve(Date.now() - serverLastConnect);
              break;
          }
        }
      })();
      await srv.stop();
      const elapsed = await dt;
      assert.ok(elapsed >= 500 && elapsed <= 700, `elapsed was ${elapsed}`);
      await nc.closed();
    });

    it("reconnect - indefinite reconnects", async () => {
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
              nc.close();
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
      assert.ok(reconnects > 5);
      assert.ok(reconnect);
      assert.equal(disconnects, 1);
    });

    it("reconnect - jitter", async () => {
      const srv = await NatsServer.start();

      let called = false;
      const h = () => {
        called = true;
        return 15;
      };

      const dc = await connect({
        port: srv.port,
        reconnect: false,
      });
      const hasDefaultFn =
        typeof dc.options.reconnectDelayHandler === "function";

      const nc = await connect({
        port: srv.port,
        maxReconnectAttempts: 1,
        reconnectDelayHandler: h,
      });

      await srv.stop();
      await nc.closed();
      await dc.closed();
      assert.ok(called);
      assert.ok(hasDefaultFn);
    });

    it("reconnect - internal disconnect forces reconnect", async () => {
      const srv = await NatsServer.start();
      const nc = await connect({
        port: srv.port,
        reconnect: true,
        reconnectTimeWait: 200,
      });

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

      assert.ok(disconnect, "disconnect");
      assert.ok(stale, "stale");

      await nc.close();
      await srv.stop();
    });

    it("reconnect - close flushes pending data", async () => {
      const srv = await NatsServer.start();
      const sub = await connect({ port: srv.port });
      // large messages are written as they are published, the small
      // last one is still in the client's outbound buffer when close() runs
      const N = 129;
      let received = 0;
      const all = deferred();
      sub.subscribe("x", {
        callback: () => {
          if (++received === N) {
            all.resolve();
          }
        },
      });
      await sub.flush();

      const pub = await connect({ port: srv.port });
      const payload = new Uint8Array(512 * 1024);
      for (let i = 0; i < N - 1; i++) {
        pub.publish("x", payload);
      }
      pub.publish("x");
      await pub.close();

      try {
        await Promise.race([
          all,
          delay(10_000).then(() => {
            throw new Error(`received ${received} of ${N}`);
          }),
        ]);
      } finally {
        await sub.close();
        await srv.stop();
      }
    });

    it("reconnect - stale connection to a server that stopped reading", async () => {
      // completes the handshake, then never reads or answers pings
      const sockets = [];
      const server = net.createServer((s) => {
        sockets.push(s);
        s.on("error", () => {});
        s.write(
          `INFO {"server_id":"stall","version":"2.12.0","proto":1,"max_payload":1048576}\r\n`,
        );
        let buf = "";
        const onData = (d) => {
          buf += d.toString();
          if (buf.includes("PING\r\n")) {
            s.write("PONG\r\n");
            s.off("data", onData);
            s.pause();
          }
        };
        s.on("data", onData);
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

      const nc = await connect({
        port: server.address().port,
        pingInterval: 250,
        maxPingOut: 2,
        reconnectTimeWait: 100,
      });
      const reconnected = deferred();
      (async () => {
        for await (const e of nc.status()) {
          if (e.type === "reconnect") {
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
        await Promise.race([
          reconnected,
          delay(5000).then(() => {
            throw new Error("stale connection never reconnected");
          }),
        ]);
      } finally {
        await nc.close();
        sockets.forEach((s) => s.destroy());
        server.close();
      }
    });
  },
);
