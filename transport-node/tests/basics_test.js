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
  ErrorCode,
  createInbox,
} = require(
  "../lib/mod",
);

const {
  VERSION,
} = require("../lib/node_transport");

const { Lock } = require("./helpers/lock");
const { NatsServer } = require("./helpers/launcher");
const { jetstreamServerConf } = require("./helpers/jsutil.js");

const u = "demo.nats.io:4222";

describe(
  "basics",
  { timeout: 20_000, concurrency: true, forceExit: true },
  () => {
    it("basics - reported version", () => {
      const pkg = require("../package.json");
      assert.equal(VERSION, pkg.version);
    });
    it("basics - connect default", async () => {
      const ns = await NatsServer.start({ port: 4222 });
      const nc = await connect();
      await nc.flush();
      await nc.close();
      await ns.stop();
    });

    it("basics - tls connect", async () => {
      const nc = await connect({ servers: ["demo.nats.io"] });
      assert.equal(nc.protocol.transport?.isEncrypted(), true);
      await nc.flush();
      await nc.close();
    });

    it("basics - connect host", async () => {
      const nc = await connect({ servers: "demo.nats.io" });
      await nc.flush();
      await nc.close();
    });

    it("basics - connect hostport", async () => {
      const nc = await connect({ servers: "demo.nats.io:4222" });
      await nc.flush();
      await nc.close();
    });

    it("basics - connect servers", async () => {
      const nc = await connect({ servers: ["demo.nats.io"] });
      await nc.flush();
      await nc.close();
    });

    it("basics - fail connect", async () => {
      await connect({ servers: "127.0.0.1:32001" })
        .then(() => {
          assert.fail("should have not connected");
        })
        .catch((err) => {
          assert.equal(err.code, ErrorCode.ConnectionRefused);
        });
    });

    it("basics - pubsub", async () => {
      const subj = createInbox();
      const nc = await connect({ servers: u });
      const sub = nc.subscribe(subj);
      const iter = (async () => {
        for await (const _ of sub) {
          break;
        }
      })();

      nc.publish(subj);
      await iter;
      assert.equal(sub.getProcessed(), 1);
      await nc.close();
    });

    it("basics - request", async () => {
      const nc = await connect({ servers: u });
      const s = createInbox();
      const sub = nc.subscribe(s);
      const _ = (async () => {
        for await (const m of sub) {
          m.respond("foo");
        }
      })();
      const msg = await nc.request(s);
      await nc.close();
      assert.equal(msg.string(), "foo");
    });

    it("basics - socket error", async () => {
      const ns = await NatsServer.start(jetstreamServerConf());
      const nc = await connect({ port: ns.port, reconnect: false });
      const closed = nc.closed();
      nc.protocol.transport.socket.emit(
        "error",
        new Error("something bad happened"),
      );
      nc.protocol.transport.socket.emit("close");
      const err = await closed;
      assert.equal(err?.message, "something bad happened");
      ns.stop();
    });

    it("basics - server gone", async () => {
      const ns = await NatsServer.start(jetstreamServerConf());
      const nc = await connect({
        port: ns.port,
        maxReconnectAttempts: 3,
        reconnectTimeWait: 100,
      });
      const closed = nc.closed();
      await ns.stop();
      const err = await closed;
      assert.equal(err?.code, ErrorCode.ConnectionRefused);
    });

    it("basics - server error", async () => {
      const ns = await NatsServer.start();
      const nc = await connect({ port: ns.port, reconnect: false });
      setTimeout(() => {
        nc.protocol.sendCommand("X\r\n");
      });
      const err = await nc.closed();
      assert.equal(err?.code, ErrorCode.ProtocolError);
      await ns.stop();
    });

    it("basics - disconnect reconnects", async () => {
      const ns = await NatsServer.start();
      const nc = await connect({ port: ns.port });
      const lock = new Lock(1);
      const status = nc.status();
      (async () => {
        for await (const s of status) {
          switch (s.type) {
            case "reconnect":
              lock.unlock();
              break;
            default:
          }
        }
      })().then();

      nc.protocol.transport.disconnect();
      await lock;
      await nc.close();
      await ns.stop();
    });
  },
);
