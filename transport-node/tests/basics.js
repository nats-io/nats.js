/*
 * Copyright 2018-2022 The NATS Authors
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
const { describe, it, test, suite } = require("node:test");
const assert = require("node:assert").strict;
const {
  connect,
  ErrorCode,
  createInbox,
  StringCodec,
  Empty,
  jwtAuthenticator,
} = require(
  "../lib/mod",
);

const { AckPolicy, jetstream, jetstreamManager } = require(
  "@nats-io/jetstream",
);

const net = require("net");

const { deferred, delay, nuid } = require(
  "@nats-io/nats-core/internal",
);
const { Lock } = require("./helpers/lock");
const { NatsServer } = require("./helpers/launcher");
const { jetstreamServerConf } = require("./helpers/jsutil.js");

const u = "demo.nats.io:4222";

describe(
  "basics",
  { timeout: 20_000, concurrency: true, forceExit: true },
  () => {
    it("basics - connect default", async () => {
      const ns = await NatsServer.start({ port: 4222 });
      const nc = await connect();
      await nc.flush();
      await nc.close();
      await ns.stop();
    });

    it("basics - tls connect", async () => {
      const nc = await connect({ servers: ["demo.nats.io:4443"] });
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

    it("basics - publish", async () => {
      const nc = await connect({ servers: u });
      nc.publish(createInbox());
      await nc.flush();
      await nc.close();
    });

    it("basics - no publish without subject", async () => {
      const nc = await connect({ servers: u });
      try {
        nc.publish("");
        assert.fail("should not be able to publish without a subject");
      } catch (err) {
        assert.equal(err.code, ErrorCode.BadSubject);
      } finally {
        await nc.close();
      }
    });

    it("basics - pubsub", async () => {
      const subj = createInbox();
      const nc = await connect({ servers: u });
      const sub = nc.subscribe(subj);
      const iter = (async () => {
        for await (const m of sub) {
          break;
        }
      })();

      nc.publish(subj);
      await iter;
      assert.equal(sub.getProcessed(), 1);
      await nc.close();
    });

    it("basics - subscribe and unsubscribe", async () => {
      const subj = createInbox();
      const nc = await connect({ servers: u });
      const sub = nc.subscribe(subj, { max: 1000, queue: "aaa" });

      // check the subscription
      assert.equal(nc.protocol.subscriptions.size(), 1);
      let s = nc.protocol.subscriptions.get(1);
      assert.ok(s);
      assert.equal(s.getReceived(), 0);
      assert.equal(s.subject, subj);
      assert.ok(s.callback);
      assert.equal(s.max, 1000);
      assert.equal(s.queue, "aaa");

      // modify the subscription
      sub.unsubscribe(10);
      s = nc.protocol.subscriptions.get(1);
      assert.ok(s);
      assert.equal(s.max, 10);

      // verify subscription updates on message
      nc.publish(subj);
      await nc.flush();
      s = nc.protocol.subscriptions.get(1);
      assert.ok(s);
      assert.equal(s.getReceived(), 1);

      // verify cleanup
      sub.unsubscribe();
      assert.equal(nc.protocol.subscriptions.size(), 0);
      await nc.close();
    });

    it("basics - subscriptions iterate", async () => {
      const nc = await connect({ servers: u });
      const lock = Lock();
      const subj = createInbox();
      const sub = nc.subscribe(subj);
      const _ = (async () => {
        for await (const m of sub) {
          lock.unlock();
        }
      })();
      nc.publish(subj);
      await nc.flush();
      await lock;
      await nc.close();
    });

    it("basics - subscriptions pass exact subject to cb", async () => {
      const s = createInbox();
      const subj = `${s}.foo.bar.baz`;
      const nc = await connect({ servers: u });
      const sub = nc.subscribe(`${s}.*.*.*`);
      const sp = deferred();
      const _ = (async () => {
        for await (const m of sub) {
          sp.resolve(m.subject);
          break;
        }
      })();
      nc.publish(subj);
      await nc.flush();

      assert.equal(await sp, subj);
      await nc.close();
    });

    it("basics - subscribe returns Subscription", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const sub = nc.subscribe(subj);
      assert.equal(sub.sid, 1);
      assert.equal(typeof sub.getReceived, "function");
      assert.equal(typeof sub.drain, "function");
      assert.equal(typeof sub.isClosed, "function");
      assert.equal(typeof sub.callback, "function");
      assert.equal(typeof sub.getSubject, "function");
      assert.equal(typeof sub.getID, "function");
      assert.equal(typeof sub.getMax, "function");
      await nc.close();
    });

    it("basics - wildcard subscriptions", async () => {
      const single = 3;
      const partial = 2;
      const full = 5;

      let nc = await connect({ servers: u });
      const s = createInbox();

      const sub = nc.subscribe(`${s}.*`);
      const sub2 = nc.subscribe(`${s}.foo.bar.*`);
      const sub3 = nc.subscribe(`${s}.foo.>`);

      nc.publish(`${s}.bar`);
      nc.publish(`${s}.baz`);
      nc.publish(`${s}.foo.bar.1`);
      nc.publish(`${s}.foo.bar.2`);
      nc.publish(`${s}.foo.baz.3`);
      nc.publish(`${s}.foo.baz.foo`);
      nc.publish(`${s}.foo.baz`);
      nc.publish(`${s}.foo`);

      await nc.drain();
      assert.equal(sub.getReceived(), single, "single");
      assert.equal(sub2.getReceived(), partial, "partial");
      assert.equal(sub3.getReceived(), full, "full");
    });

    it("basics - correct data in message", async () => {
      const sc = StringCodec();
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const mp = deferred();
      const sub = nc.subscribe(subj);
      const _ = (async () => {
        for await (const m of sub) {
          mp.resolve(m);
          break;
        }
      })();

      nc.publish(subj, sc.encode(subj));
      const m = await mp;
      assert.equal(m.subject, subj);
      assert.equal(sc.decode(m.data), subj);
      assert.equal(m.reply, "");
      await nc.close();
    });

    it("basics - correct reply in message", async () => {
      const nc = await connect({ servers: u });
      const s = createInbox();
      const r = createInbox();

      const rp = deferred();
      const sub = nc.subscribe(s);
      const _ = (async () => {
        for await (const m of sub) {
          rp.resolve(m.reply);
          break;
        }
      })();
      nc.publish(s, Empty, { reply: r });
      assert.equal(await rp, r);
      await nc.close();
    });

    it("basics - respond returns false if no reply subject set", async () => {
      let nc = await connect({ servers: u });
      let s = createInbox();
      const dr = deferred();
      const sub = nc.subscribe(s);
      const _ = (async () => {
        for await (const m of sub) {
          dr.resolve(m.respond());
          break;
        }
      })();
      nc.publish(s);
      const responded = await dr;
      assert.ok(!responded);
      await nc.close();
    });

    it("basics - closed cannot subscribe", async () => {
      let nc = await connect({ servers: u });
      await nc.close();
      let failed = false;
      try {
        nc.subscribe(createInbox());
        assert.fail("should have not been able to subscribe");
      } catch (err) {
        failed = true;
      }
      assert.ok(failed);
    });

    it("basics - close cannot request", async () => {
      let nc = await connect({ servers: u });
      await nc.close();
      let failed = false;
      try {
        await nc.request(createInbox());
        assert.fail("should have not been able to request");
      } catch (err) {
        failed = true;
      }
      assert.ok(failed);
    });

    it("basics - flush returns promise", async () => {
      const nc = await connect({ servers: u });
      let p = nc.flush();
      if (!p) {
        assert.fail("should have returned a promise");
      }
      await p;
      await nc.close();
    });

    it("basics - unsubscribe after close no error", async () => {
      let nc = await connect({ servers: u });
      let sub = nc.subscribe(createInbox());
      await nc.close();
      sub.unsubscribe();
    });

    it("basics - unsubscribe stops messages", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      // in this case we use a callback otherwise messages are buffered.
      const sub = nc.subscribe(subj, {
        callback: () => {
          sub.unsubscribe();
        },
      });
      nc.publish(subj);
      nc.publish(subj);
      nc.publish(subj);
      nc.publish(subj);

      await nc.flush();
      assert.equal(sub.getReceived(), 1);
      await nc.close();
    });

    it("basics - request", async () => {
      const sc = StringCodec();
      const nc = await connect({ servers: u });
      const s = createInbox();
      const sub = nc.subscribe(s);
      const _ = (async () => {
        for await (const m of sub) {
          m.respond(sc.encode("foo"));
        }
      })();
      const msg = await nc.request(s);
      await nc.close();
      assert.equal(sc.decode(msg.data), "foo");
    });

    it("basics - request timeout", async () => {
      const nc = await connect({ servers: u });
      const s = createInbox();
      const lock = Lock();

      nc.request(s, Empty, { timeout: 100 })
        .then(() => {
          fail();
        })
        .catch((err) => {
          assert.ok(
            err.code === ErrorCode.Timeout ||
              err.code === ErrorCode.NoResponders,
          );
          lock.unlock();
        });

      await lock;
      await nc.close();
    });

    it("basics - request cancel rejects", async () => {
      const nc = await connect({ servers: u });
      const s = createInbox();
      const lock = Lock();

      nc.request(s, Empty, { timeout: 1000 })
        .then(() => {
          assert.fail();
        })
        .catch((err) => {
          assert.equal(err.code, ErrorCode.Cancelled);
          lock.unlock();
        });

      nc.protocol.muxSubscriptions.reqs.forEach((v) => {
        v.cancel();
      });
      await lock;
      await nc.close();
    });

    it("basics - close promise resolves", async () => {
      const ns = await NatsServer.start();
      const nc = await connect({ port: ns.port, reconnect: false });

      setTimeout(() => {
        ns.stop();
      });

      await nc.closed().catch((err) => {
        assert.fail(err);
      });
    });

    // it("basics - initial connect error", async () => {
    //   const pp = deferred();
    //   const server = net.createServer();
    //   let connects = 0;
    //   server.on("connection", (conn) => {
    //     let closed = false;
    //     connects++;
    //     const buf = Buffer.from(
    //       `INFO {"server_id":"FAKE","server_name":"FAKE","version":"2.9.4","proto":1,"go":"go1.19.2","host":"127.0.0.1","port":${port},"headers":true,"max_payload":1048576,"jetstream":true,"client_id":4,"client_ip":"127.0.0.1"}\r\n`,
    //     );
    //     conn.write(buf);
    //     setTimeout(() => {
    //       closed = true;
    //       conn.end();
    //     });
    //   });
    //
    //   server.listen(0, (v) => {
    //     const p = server.address().port;
    //     pp.resolve(p);
    //   });
    //
    //   const port = await pp;
    //   // we expect to die with a disconnect
    //   try {
    //     await connect({ port });
    //     assert.fail("shouldn't have connected");
    //   } catch (err) {
    //     assert.equal(err.code, ErrorCode.Timeout);
    //   }
    //   server.close();
    // });

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

    it("basics - subscription with timeout", async () => {
      const nc = await connect({ servers: u });
      const lock = Lock(1);
      const sub = nc.subscribe(createInbox(), { max: 1, timeout: 250 });
      (async () => {
        for await (const m of sub) {
        }
      })().catch((err) => {
        assert.equal(err.code, ErrorCode.Timeout);
        lock.unlock();
      });
      await lock;
      await nc.close();
    });

    it("basics - subscription expecting 2 doesn't fire timeout", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const sub = nc.subscribe(subj, { max: 2, timeout: 500 });
      (async () => {
        for await (const m of sub) {
        }
      })().catch((err) => {
        assert.fail(err);
      });

      nc.publish(subj);
      await nc.flush();
      await delay(1000);

      assert.equal(sub.getReceived(), 1);
      await nc.close();
    });

    it("basics - subscription timeout auto cancels", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      let c = 0;
      const sub = nc.subscribe(subj, { max: 2, timeout: 300 });
      (async () => {
        for await (const m of sub) {
          c++;
        }
      })().catch((err) => {
        assert.fail(err.message);
      });

      nc.publish(subj);
      nc.publish(subj);
      await delay(500);
      assert.equal(c, 2);
      await nc.close();
    });

    it("basics - no mux requests create normal subs", async () => {
      const nc = await connect({ servers: u });
      const _ = nc.request(createInbox(), Empty, {
        timeout: 1000,
        noMux: true,
      });
      assert.equal(nc.protocol.subscriptions.size(), 1);
      assert.equal(nc.protocol.muxSubscriptions.size(), 0);
      const sub = nc.protocol.subscriptions.get(1);
      assert.ok(sub);
      assert.equal(sub.max, 1);
      sub.unsubscribe();
      assert.equal(nc.protocol.subscriptions.size(), 0);
      await nc.close();
    });

    it("basics - no mux requests timeout", async () => {
      const nc = await connect({ servers: u });
      const lock = Lock();
      nc.request(createInbox(), Empty, { timeout: 250, noMux: true })
        .catch((err) => {
          assert.ok(
            err.code === ErrorCode.Timeout ||
              err.code === ErrorCode.NoResponders,
          );
          lock.unlock();
        });
      await lock;
      await nc.close();
    });

    it("basics - no mux requests", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const sub = nc.subscribe(subj);
      const data = Uint8Array.from([1234]);
      (async () => {
        for await (const m of sub) {
          m.respond(data);
        }
      })().then();

      const m = await nc.request(subj, Empty, { timeout: 1000, noMux: true });
      assert.deepEqual(Uint8Array.from(m.data), data);
      await nc.close();
    });

    it("basics - no max_payload messages", async () => {
      const nc = await connect({ servers: u });
      assert.ok(nc.protocol.info.max_payload);
      const big = new Uint8Array(nc.protocol.info.max_payload + 1);

      const subj = createInbox();
      try {
        nc.publish(subj, big);
        assert.fail();
      } catch (err) {
        assert.equal(err.code, ErrorCode.MaxPayloadExceeded);
      }

      try {
        const _ = await nc.request(subj, big);
        assert.fail();
      } catch (err) {
        assert.equal(err.code, ErrorCode.MaxPayloadExceeded);
      }

      const sub = nc.subscribe(subj);
      (async () => {
        for await (const m of sub) {
          m.respond(big);
          assert.fail();
        }
      })().catch((err) => {
        assert.equal(err.code, ErrorCode.MaxPayloadExceeded);
      });

      await nc.request(subj).then(() => {
        assert.fail();
      }).catch((err) => {
        assert.equal(err.code, ErrorCode.Timeout);
      });

      await nc.close();
    });

    it("basics - empty message", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const mp = deferred();
      const sub = nc.subscribe(subj);
      const _ = (async () => {
        for await (const m of sub) {
          mp.resolve(m);
          break;
        }
      })();

      nc.publish(subj);
      const m = await mp;
      assert.equal(m.subject, subj);
      assert.equal(m.data.length, 0);
      await nc.close();
    });

    it("basics - subject is required", async () => {
      const ns = await NatsServer.start();
      const nc = await connect({ port: ns.port });
      await assert.throws(() => {
        nc.publish();
      }, (err) => {
        assert.equal(err.code, ErrorCode.BadSubject);
        return true;
      });

      await assert.rejects(() => {
        return nc.request();
      }, (err) => {
        assert.equal(err.code, ErrorCode.BadSubject);
        return true;
      });

      await nc.close();
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

    it("basics - drain connection publisher", async () => {
      const nc = await connect({ servers: u });
      const nc2 = await connect({ servers: u });

      const subj = createInbox();

      const lock = new Lock(5);
      nc2.subscribe(subj, {
        callback: (err, m) => {
          lock.unlock();
        },
      });
      await nc2.flush();

      for (let i = 0; i < 5; i++) {
        nc.publish(subj);
      }
      await nc.drain();
      await lock;
      await nc.close();
      await nc2.close();
    });

    it("basics - createinbox", (t) => {
      assert.ok(createInbox());
    });

    it("basics - resolve", async () => {
      const token = process.env.NGS_CI_USER || "";
      if (token.length === 0) {
        console.log("test skipped - no NGS_CI_USER defined in the environment");
        return Promise.resolve();
      }
      const nc = await connect({
        servers: "connect.ngs.global",
        authenticator: jwtAuthenticator(token),
      });

      await nc.flush();
      const srv = nc.protocol.servers.getCurrentServer();
      assert.ok(srv.resolves && srv.resolves.length > 1);
      await nc.close();
    });

    it("basics - js fetch on stopped server doesn't close", async () => {
      let ns = await NatsServer.start(jetstreamServerConf());
      const nc = await connect({
        port: ns.port,
        maxReconnectAttempts: -1,
      });
      const status = nc.status();
      (async () => {
        let reconnects = 0;
        for await (const s of status) {
          switch (s.type) {
            case "reconnecting":
              reconnects++;
              if (reconnects === 2) {
                ns.restart().then((s) => {
                  ns = s;
                });
              }
              break;
            case "reconnect":
              setTimeout(() => {
                loop = false;
              });
              break;
            default:
              // nothing
          }
        }
      })().then();

      const jsm = await jetstreamManager(nc);
      const si = await jsm.streams.add({
        name: nuid.next(),
        subjects: ["test"],
      });
      const { name: stream } = si.config;
      await jsm.consumers.add(stream, {
        durable_name: "dur",
        ack_policy: AckPolicy.Explicit,
      });

      const js = jetstream(nc);
      setTimeout(() => {
        ns.stop();
      }, 2000);

      let loop = true;
      while (true) {
        try {
          const iter = js.fetch(stream, "dur", { batch: 1, expires: 500 });
          for await (const m of iter) {
            m.ack();
          }
          if (!loop) {
            break;
          }
        } catch (err) {
          assert.fail(`shouldn't have errored: ${err.message}`);
        }
      }
      await nc.close();
      await ns.stop();
    });
  },
);
