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
const { NatsServer } = require("./helpers/launcher");
const {
  createInbox,
  deferred,
  delay,
} = require("@nats-io/nats-core/internal");
const { Lock } = require("./helpers/lock");

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
  },
);
