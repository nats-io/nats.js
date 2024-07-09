/*
 * Copyright 2020 The NATS Authors
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
const { NatsError, MsgHdrsImpl, canonicalMIMEHeaderKey } = require(
  "@nats-io/nats-core/internal",
);

describe(
  "msgheaders",
  { timeout: 20_000, concurrency: true, forceExit: true },
  () => {
    it("msgheaders - basics", () => {
      const h = new MsgHdrsImpl();
      assert.equal(h.size(), 0);
      assert.ok(!h.has("foo"));
      h.append("foo", "bar");
      h.append("foo", "bam");
      h.append("foo-bar", "baz");

      assert.equal(h.size(), 2);
      h.set("bar-foo", "foo");
      assert.equal(h.size(), 3);
      h.delete("bar-foo");
      assert.equal(h.size(), 2);

      const header = canonicalMIMEHeaderKey("foo");
      assert.equal("Foo", header);
      assert.ok(!h.has("Foo"));
      assert.ok(h.has("foo"));
      // we are case sensitive
      let foos = h.values(header);
      assert.equal(foos.length, 0);

      foos = h.values("foo");
      assert.equal(foos.length, 2);
      assert.ok(foos.indexOf("bar") > -1);
      assert.ok(foos.indexOf("bam") > -1);
      assert.equal(foos.indexOf("baz"), -1);

      const a = h.encode();
      const hh = MsgHdrsImpl.decode(a);
      assert.ok(h.equals(hh));
      assert.equal(hh.size(), 2);
      assert.ok(hh.has("foo"));
      assert.ok(!hh.has("bar-foo"));

      hh.set("foo-bar-baz", "fbb");
      assert.ok(!h.equals(hh));
    });

    it("msgheaders - illegal key", () => {
      const h = new MsgHdrsImpl();
      ["bad:", "bad ", String.fromCharCode(127)].forEach((v) => {
        assert.throws(() => {
          h.set(v, "aaa");
        }, (err) => {
          assert.ok(err instanceof NatsError);
          return true;
        });
      });

      ["\r", "\n"].forEach((v) => {
        assert.throws(() => {
          h.set("a", v);
        }, (err) => {
          assert.ok(err instanceof NatsError);
          return true;
        });
      });
    });
  },
);
