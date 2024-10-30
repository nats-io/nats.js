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
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert";
import { createInbox } from "../src/internal_mod.ts";
import { Lock } from "test_helpers";
import { _setup, cleanup } from "test_helpers";
import { connect } from "./connect.ts";
import { errors } from "../src/errors.ts";

Deno.test("drain - connection drains when no subs", async () => {
  const { ns, nc } = await _setup(connect);
  await nc.drain();
  await cleanup(ns);
});

Deno.test("drain - connection drain", async () => {
  const { ns, nc } = await _setup(connect);
  const nc2 = await connect({ port: ns.port });

  const max = 1000;
  const lock = Lock(max);
  const subj = createInbox();

  let first = true;
  await nc.subscribe(subj, {
    callback: () => {
      lock.unlock();
      if (first) {
        first = false;
        nc.drain();
      }
    },
    queue: "q1",
  });

  let count = 0;
  await nc2.subscribe(subj, {
    callback: () => {
      lock.unlock();
      count++;
    },
    queue: "q1",
  });

  await nc.flush();
  await nc2.flush();

  for (let i = 0; i < max; i++) {
    nc2.publish(subj);
  }
  await nc2.drain();
  await lock;
  await nc.closed();
  assert(count > 0, "expected second connection to get some messages");

  await ns.stop();
});

Deno.test("drain - subscription drain", async () => {
  const { ns, nc } = await _setup(connect);
  const lock = Lock();
  const subj = createInbox();
  let c1 = 0;
  const s1 = nc.subscribe(subj, {
    callback: () => {
      c1++;
      if (!s1.isDraining()) {
        // resolve when done
        s1.drain()
          .then(() => {
            lock.unlock();
          });
      }
    },
    queue: "q1",
  });

  let c2 = 0;
  nc.subscribe(subj, {
    callback: () => {
      c2++;
    },
    queue: "q1",
  });

  for (let i = 0; i < 10000; i++) {
    nc.publish(subj);
  }
  await nc.flush();
  await lock;

  assertEquals(c1 + c2, 10000);
  assert(c1 >= 1, "s1 got more than one message");
  assert(c2 >= 1, "s2 got more than one message");
  assert(s1.isClosed());
  await cleanup(ns, nc);
});

Deno.test("drain - publish after drain fails", async () => {
  const { ns, nc } = await _setup(connect);
  const subj = createInbox();
  nc.subscribe(subj);
  await nc.drain();

  try {
    nc.publish(subj);
  } catch (err) {
    assert(
      err instanceof errors.ClosedConnectionError ||
        err instanceof errors.DrainingConnectionError,
    );
  }

  await ns.stop();
});

Deno.test("drain - reject reqrep during connection drain", async () => {
  const { ns, nc } = await _setup(connect);
  const done = nc.drain();
  await assertRejects(() => {
    return nc.request("foo");
  }, errors.DrainingConnectionError);
  await done;
  await cleanup(ns, nc);
});

Deno.test("drain - reject drain on closed", async () => {
  const { ns, nc } = await _setup(connect);
  await nc.close();
  await assertRejects(() => {
    return nc.drain();
  }, errors.ClosedConnectionError);
  await ns.stop();
});

Deno.test("drain - reject drain on draining", async () => {
  const { ns, nc } = await _setup(connect);
  const done = nc.drain();
  await assertRejects(() => {
    return nc.drain();
  }, errors.DrainingConnectionError);
  await done;
  await ns.stop();
});

Deno.test("drain - reject subscribe on draining", async () => {
  const { ns, nc } = await _setup(connect);
  const done = nc.drain();
  assertThrows(() => {
    return nc.subscribe("foo");
  }, errors.DrainingConnectionError);

  await done;
  await ns.stop();
});

Deno.test("drain - reject subscription drain on closed sub callback", async () => {
  const { ns, nc } = await _setup(connect);
  const sub = nc.subscribe("foo", { callback: () => {} });
  sub.unsubscribe();
  await assertRejects(
    () => {
      return sub.drain();
    },
    errors.InvalidOperationError,
    "subscription is already closed",
  );
  await nc.close();
  await ns.stop();
});

Deno.test("drain - reject subscription drain on closed sub iter", async () => {
  const { ns, nc } = await _setup(connect);
  const sub = nc.subscribe("foo");
  const d = (async () => {
    for await (const _ of sub) {
      // nothing
    }
  })().then();

  sub.unsubscribe();
  await d;
  await assertRejects(
    () => {
      return sub.drain();
    },
    errors.InvalidOperationError,
    "subscription is already closed",
  );
  await nc.close();
  await ns.stop();
});

Deno.test("drain - connection is closed after drain", async () => {
  const { ns, nc } = await _setup(connect);
  nc.subscribe("foo");
  await nc.drain();
  assert(nc.isClosed());
  await ns.stop();
});

Deno.test("drain - reject subscription drain on closed", async () => {
  const { ns, nc } = await _setup(connect);
  const sub = nc.subscribe("foo");
  await nc.close();
  await assertRejects(() => {
    return sub.drain();
  }, errors.ClosedConnectionError);
  await ns.stop();
});

Deno.test("drain - multiple sub drain returns same promise", async () => {
  const { ns, nc } = await _setup(connect);
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  const p1 = sub.drain();
  const p2 = sub.drain();
  assertEquals(p1, p2);
  nc.publish(subj);
  await nc.flush();
  await p1;
  await cleanup(ns, nc);
});

Deno.test("drain - publisher drain", async () => {
  const { ns, nc } = await _setup(connect);
  const nc1 = await connect({ port: ns.port });

  const subj = createInbox();
  const lock = Lock(10);

  nc.subscribe(subj, {
    callback: () => {
      lock.unlock();
    },
  });
  await nc.flush();

  for (let i = 0; i < 10; i++) {
    nc1.publish(subj);
  }
  await nc1.drain();
  await lock;
  await cleanup(ns, nc, nc1);
});
