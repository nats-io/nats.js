/*
 * Copyright 2020-2023 The NATS Authors
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
import { connect } from "./connect.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { Lock, NatsServer } from "test_helpers";
import {
  createInbox,
  delay,
  nuid,
  QueuedIteratorImpl,
  syncIterator,
} from "../src/internal_mod.ts";
import type { NatsConnectionImpl } from "../src/internal_mod.ts";
import { cleanup, setup } from "test_helpers";
import { errors } from "../src/errors.ts";

Deno.test("iterators - unsubscribe breaks and closes", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  const done = (async () => {
    for await (const _m of sub) {
      if (sub.getReceived() > 1) {
        sub.unsubscribe();
      }
    }
  })();
  nc.publish(subj);
  nc.publish(subj);
  await done;
  assertEquals(sub.getReceived(), 2);
  await cleanup(ns, nc);
});

Deno.test("iterators - autounsub breaks and closes", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const sub = nc.subscribe(subj, { max: 2 });
  const lock = Lock(2);
  const done = (async () => {
    for await (const _m of sub) {
      lock.unlock();
    }
  })();
  nc.publish(subj);
  nc.publish(subj);
  await done;
  await lock;
  assertEquals(sub.getReceived(), 2);
  await cleanup(ns, nc);
});

Deno.test("iterators - permission error breaks and closes", async () => {
  const conf = {
    authorization: {
      users: [{
        user: "derek",
        password: "foobar",
        permission: {
          subscribe: "bar",
          publish: "foo",
        },
      }],
    },
  };
  const ns = await NatsServer.start(conf);
  const nc = await connect(
    { port: ns.port, user: "derek", pass: "foobar" },
  );
  const sub = nc.subscribe("foo");

  const lock = Lock();
  await (async () => {
    for await (const _m of sub) {
      // ignored
    }
  })().catch(() => {
    lock.unlock();
  });

  await lock;
  await cleanup(ns, nc);
});

Deno.test("iterators - unsubscribing closes", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  const lock = Lock();
  const done = (async () => {
    for await (const _m of sub) {
      lock.unlock();
    }
  })();
  nc.publish(subj);
  await lock;
  sub.unsubscribe();
  await done;
  await cleanup(ns, nc);
});

Deno.test("iterators - connection close closes", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  const lock = Lock();
  const done = (async () => {
    for await (const _m of sub) {
      lock.unlock();
    }
  })();
  nc.publish(subj);
  await nc.flush();
  await nc.close();
  await lock;
  await done;
  await ns.stop();
});

Deno.test("iterators - cb subs fail iterator", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const sub = nc.subscribe(subj, { callback: () => {} });

  await assertRejects(
    async () => {
      for await (const _ of sub) {
        // nothing
      }
    },
    errors.InvalidOperationError,
    "iterator cannot be used when a callback is registered",
  );

  nc.publish(subj);
  await nc.flush();
  await cleanup(ns, nc);
});

Deno.test("iterators - cb message counts", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const lock = Lock(3);
  const sub = nc.subscribe(subj, {
    callback: () => {
      lock.unlock();
    },
  });

  nc.publish(subj);
  nc.publish(subj);
  nc.publish(subj);

  await lock;

  assertEquals(sub.getReceived(), 3);
  assertEquals(sub.getProcessed(), 3);
  assertEquals(sub.getPending(), 0);
  await cleanup(ns, nc);
});

Deno.test("iterators - push on done is noop", async () => {
  const qi = new QueuedIteratorImpl<string>();
  const buf: string[] = [];
  const done = (async () => {
    for await (const s of qi) {
      buf.push(s);
    }
  })();

  qi.push("a");
  qi.push("b");
  qi.push("c");
  qi.stop();
  await done;
  assertEquals(buf.length, 3);
  assertEquals("a,b,c", buf.join(","));

  qi.push("d");
  assertEquals(buf.length, 3);
  assertEquals("a,b,c", buf.join(","));
});

Deno.test("iterators - break cleans up", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  const done = (async () => {
    for await (const _m of sub) {
      break;
    }
  })();
  nc.publish(subj);
  await done;

  assertEquals(sub.isClosed(), true);
  assertEquals(nci.protocol.subscriptions.subs.size, 0);

  await cleanup(ns, nc);
});

Deno.test("iterators - sync iterator", async () => {
  const { ns, nc } = await setup();
  const subj = nuid.next();
  const sub = nc.subscribe(subj);
  const sync = syncIterator(sub);
  nc.publish(subj, "a");
  let m = await sync.next();
  assertEquals(m?.string(), "a");
  nc.publish(subj, "b");
  m = await sync.next();
  assertEquals(m?.string(), "b");
  const p = sync.next();
  // blocks until next message
  const v = await Promise.race([
    delay(250).then(() => {
      return "timer";
    }),
    p,
  ]);
  assertEquals(v, "timer");
  await assertRejects(
    async () => {
      for await (const _m of sub) {
        // should fail
      }
    },
    Error,
    "already yielding",
  );

  const sub2 = nc.subscribe("foo", {
    callback: () => {
    },
  });
  await assertRejects(
    async () => {
      for await (const _m of sub2) {
        // should fail
      }
    },
    Error,
    "iterator cannot be used when a callback is registered",
  );

  await cleanup(ns, nc);
});
