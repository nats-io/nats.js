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
} = require(
  "../index",
);
const { jetstream, jetstreamManager } = require(
  "@nats-io/jetstream",
);
const { Kvm } = require("@nats-io/kv");
const { Objm } = require("@nats-io/obj");

describe(
  "jetstream",
  { timeout: 20_000, concurrency: true, forceExit: true },
  () => {
    it("jetstream is a function", async () => {
      assert.equal(typeof jetstream, "function");
      const nc = await connect({ servers: "demo.nats.io" });
      const js = jetstream(nc);
      assert.ok(js);
      await nc.close();
    });

    it("jetstreamManager is a function", async () => {
      assert.equal(typeof jetstreamManager, "function");
      const nc = await connect({ servers: "demo.nats.io" });
      const jsm = await jetstreamManager(nc);
      await jsm.getAccountInfo();
      await nc.close();
    });

    it("kvm is a function", async () => {
      assert.equal(typeof Kvm, "function");
      const nc = await connect({ servers: "demo.nats.io" });
      const kvm = new Kvm(nc);
      let c = 0;
      for await (const _ of kvm.list()) {
        c++;
      }
      assert.ok(c >= 0);
      await nc.close();
    });

    it("objm is a function", async () => {
      assert.equal(typeof Objm, "function");
      const nc = await connect({ servers: "demo.nats.io" });
      const objm = new Objm(nc);
      let c = 0;
      for await (const _ of objm.list()) {
        c++;
      }
      assert.ok(c >= 0);
      await nc.close();
    });
  },
);
