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
const { describe, it } = require("node:test");
const assert = require("node:assert").strict;
const { connect, ErrorCode, createInbox, Empty } = require(
  "../index",
);
const { Lock } = require("./helpers/lock");

const u = "demo.nats.io:4222";
describe(
  "autounsub",
  { timeout: 20_000, concurrency: true, forceExit: true },
  () => {
    it("max option", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const sub = nc.subscribe(subj, { max: 10 });
      for (let i = 0; i < 20; i++) {
        nc.publish(subj);
      }
      await nc.flush();
      assert.equal(sub.getReceived(), 10);
      await nc.close();
    });

    it("unsubscribe", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const sub = nc.subscribe(subj, { max: 10 });
      sub.unsubscribe(11);
      for (let i = 0; i < 20; i++) {
        nc.publish(subj);
      }
      await nc.flush();
      assert.equal(sub.getReceived(), 11);
      await nc.close();
    });

    it("can unsub from auto-unsubscribed", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const sub = nc.subscribe(subj, { max: 1 });
      for (let i = 0; i < 20; i++) {
        nc.publish(subj);
      }
      await nc.flush();
      assert.equal(sub.getReceived(), 1);
      sub.unsubscribe();
      await nc.close();
    });

    it("can break to unsub", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const sub = nc.subscribe(subj, { max: 20 });
      const iter = (async () => {
        for await (const m of sub) {
          break;
        }
      })();
      for (let i = 0; i < 20; i++) {
        nc.publish(subj);
      }
      await nc.flush();
      await iter;
      assert.equal(sub.getProcessed(), 1);
      await nc.close();
    });

    it("can change auto-unsub to a higher value", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const sub = nc.subscribe(subj, { max: 1 });
      sub.unsubscribe(10);
      for (let i = 0; i < 20; i++) {
        nc.publish(subj);
      }
      await nc.flush();
      assert.equal(sub.getReceived(), 10);
      await nc.close();
    });

    it("request receives expected count with multiple helpers", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();

      const fn = async (sub) => {
        for await (const m of sub) {
          m.respond();
        }
      };
      const subs = [];
      for (let i = 0; i < 5; i++) {
        const sub = nc.subscribe(subj);
        const _ = fn(sub);
        subs.push(sub);
      }
      await nc.request(subj);
      await nc.drain();

      let counts = subs.map((s) => {
        return s.getReceived();
      });
      const count = counts.reduce((a, v) => a + v);
      assert.equal(count, 5);
    });

    it("manual request receives expected count with multiple helpers", async () => {
      const nc = await connect({ servers: u });
      const subj = createInbox();
      const lock = Lock(5);

      const fn = async (sub) => {
        for await (const m of sub) {
          m.respond();
          lock.unlock();
        }
      };
      for (let i = 0; i < 5; i++) {
        const sub = nc.subscribe(subj);
        const _ = fn(sub);
      }
      const replySubj = createInbox();
      const sub = nc.subscribe(replySubj);
      nc.publish(subj, Empty, { reply: replySubj });
      await lock;
      await nc.drain();
      assert.equal(sub.getReceived(), 5);
    });

    it("check subscription leaks", async () => {
      let nc = await connect({ servers: u });
      let subj = createInbox();
      let sub = nc.subscribe(subj);
      sub.unsubscribe();
      assert.equal(nc.protocol.subscriptions.size(), 0);
      await nc.close();
    });

    it("check request leaks", async () => {
      let nc = await connect({ servers: u });
      let subj = createInbox();

      // should have no subscriptions
      assert.equal(nc.protocol.subscriptions.size(), 0);

      let sub = nc.subscribe(subj);
      const _ = (async () => {
        for await (const m of sub) {
          m.respond();
        }
      })();

      // should have one subscription
      assert.equal(nc.protocol.subscriptions.size(), 1);

      let msgs = [];
      msgs.push(nc.request(subj));
      msgs.push(nc.request(subj));

      // should have 2 mux subscriptions, and 2 subscriptions
      assert.equal(nc.protocol.subscriptions.size(), 2);
      assert.equal(nc.protocol.muxSubscriptions.size(), 2);

      await Promise.all(msgs);

      // mux subs should have pruned
      assert.equal(nc.protocol.muxSubscriptions.size(), 0);

      sub.unsubscribe();
      assert.equal(nc.protocol.subscriptions.size(), 1);
      await nc.close();
    });

    it("check cancelled request leaks", async () => {
      let nc = await connect({ servers: u });
      let subj = createInbox();

      // should have no subscriptions
      assert.equal(nc.protocol.subscriptions.size(), 0);

      let rp = nc.request(subj, Empty, { timeout: 100 });

      assert.equal(nc.protocol.subscriptions.size(), 1);
      assert.equal(nc.protocol.muxSubscriptions.size(), 1);

      // the rejection should be timeout
      const lock = Lock();
      rp.catch((rej) => {
        assert.ok(
          rej.code === ErrorCode.Timeout || rej.code === ErrorCode.NoResponders,
        );
        lock.unlock();
      });

      await lock;
      // mux subs should have pruned
      assert.equal(nc.protocol.muxSubscriptions.size(), 0);
      await nc.close();
    });
  },
);
