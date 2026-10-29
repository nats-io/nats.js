/*
 * Copyright 2022-2023 The NATS Authors
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
import { cleanup, setup } from "nst";
import type {
  Msg,
  NatsConnection,
  NatsConnectionImpl,
  QueuedIteratorImpl,
  RequestManyOptions,
} from "../src/internal_mod.ts";
import { createInbox, deferred, delay, Empty } from "../src/internal_mod.ts";

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  fail,
} from "@std/assert";
import { errors } from "../src/errors.ts";

async function requestManyCount(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const nci = nc as NatsConnectionImpl;

  let payload = "";
  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      if (payload === "") {
        payload = msg.string();
      }
      for (let i = 0; i < 5; i++) {
        msg.respond();
      }
    },
  });

  const iter = await nci.requestMany(subj, "hello", {
    strategy: "count",
    maxWait: 2000,
    maxMessages: 5,
    noMux,
  });

  for await (const mer of iter) {
    if (mer instanceof Error) {
      fail(mer.message);
    }
  }

  assertEquals(nci.protocol.subscriptions.size(), noMux ? 1 : 2);
  assertEquals(payload, "hello");
  assertEquals(iter.getProcessed(), 5);
  await cleanup(ns, nc);
}

Deno.test("mreq - request many count", async () => {
  await requestManyCount();
});

Deno.test("mreq - request many count noMux", async () => {
  await requestManyCount(true);
});

async function requestManyJitter(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const nci = nc as NatsConnectionImpl;

  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      for (let i = 0; i < 10; i++) {
        msg.respond();
      }
    },
  });

  const start = Date.now();

  const iter = await nci.requestMany(subj, Empty, {
    strategy: "stall",
    maxWait: 5000,
    noMux,
  });
  for await (const mer of iter) {
    if (mer instanceof Error) {
      fail(mer.message);
    }
  }
  const time = Date.now() - start;
  assert(1000 > time);
  assertEquals(iter.getProcessed(), 10);
  await cleanup(ns, nc);
}

Deno.test("mreq - request many jitter", async () => {
  await requestManyJitter();
});

Deno.test("mreq - request many jitter noMux", async () => {
  await requestManyJitter(true);
});

async function requestManySentinel(
  noMux = false,
  partial = false,
): Promise<void> {
  const { ns, nc } = await setup({});
  const nci = nc as NatsConnectionImpl;

  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      for (let i = 0; i < 10; i++) {
        msg.respond("hello");
      }
      if (!partial) {
        msg.respond();
      }
    },
  });

  const start = Date.now();
  const iter = await nci.requestMany(subj, Empty, {
    strategy: "sentinel",
    maxWait: 2000,
    noMux,
  });
  for await (const mer of iter) {
    if (mer instanceof Error) {
      fail(mer.message);
    }
  }
  const time = Date.now() - start;
  // partial will timeout
  assert(partial ? time > 500 : 500 > time);
  // partial will not have the empty message
  assertEquals(iter.getProcessed(), partial ? 10 : 11);
  await cleanup(ns, nc);
}

Deno.test("mreq - nomux request many sentinel", async () => {
  await requestManySentinel();
});

Deno.test("mreq - nomux request many sentinel noMux", async () => {
  await requestManySentinel(true);
});

Deno.test("mreq - nomux request many sentinel partial", async () => {
  await requestManySentinel(false, true);
});

Deno.test("mreq - nomux request many sentinel partial noMux", async () => {
  await requestManySentinel(true, true);
});

async function requestManyTimerNoResponse(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const nci = nc as NatsConnectionImpl;

  const subj = createInbox();
  nc.subscribe(subj, {
    callback: () => {
      // ignore it
    },
  });

  let count = 0;
  const start = Date.now();
  const iter = await nci.requestMany(subj, Empty, {
    strategy: "timer",
    maxWait: 2000,
    noMux,
  });
  for await (const mer of iter) {
    if (mer instanceof Error) {
      fail(mer.message);
    }
    count++;
  }
  const time = Date.now() - start;
  assert(time >= 2000);
  assertEquals(count, 0);
  await cleanup(ns, nc);
}

Deno.test("mreq - request many wait for timer - no response", async () => {
  await requestManyTimerNoResponse();
});

Deno.test("mreq - request many wait for timer noMux - no response", async () => {
  await requestManyTimerNoResponse(true);
});

async function requestTimerLateResponse(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const nci = nc as NatsConnectionImpl;

  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      delay(1750).then(() => {
        msg.respond();
      });
    },
  });

  let count = 0;
  const start = Date.now();
  const iter = await nci.requestMany(subj, Empty, {
    strategy: "timer",
    maxWait: 2000,
    noMux,
  });
  for await (const mer of iter) {
    if (mer instanceof Error) {
      fail(mer.message);
    }
    count++;
  }
  const time = Date.now() - start;
  assert(time >= 2000);
  assertEquals(count, 1);
  await cleanup(ns, nc);
}

Deno.test("mreq - request many waits for timer late response", async () => {
  await requestTimerLateResponse();
});

Deno.test("mreq - request many waits for timer late response noMux", async () => {
  await requestTimerLateResponse(true);
});

async function requestManyStopsOnError(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const nci = nc as NatsConnectionImpl;

  const subj = createInbox();

  const iter = await nci.requestMany(subj, Empty, {
    strategy: "timer",
    maxWait: 2000,
    noMux,
  });
  await assertRejects(
    async () => {
      for await (const _mer of iter) {
        // do nothing
      }
    },
    errors.NoRespondersError,
    subj,
  );
  await cleanup(ns, nc);
}

Deno.test("mreq - request many stops on error", async () => {
  await requestManyStopsOnError();
});

Deno.test("mreq - request many stops on error noMux", async () => {
  await requestManyStopsOnError(true);
});

Deno.test("mreq - pub permission error", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permissions: { publish: { deny: "q" } },
      }],
    },
  }, { user: "a", pass: "a" });

  const d = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (
        s.type === "error" &&
        s.error instanceof errors.PermissionViolationError &&
        s.error.operation === "publish" && s.error.subject === "q"
      ) {
        d.resolve();
      }
    }
  })().then();

  const iter = await nc.requestMany("q", Empty, {
    strategy: "count",
    maxMessages: 3,
    maxWait: 2000,
  });

  await assertRejects(
    async () => {
      for await (const _m of iter) {
        // nothing
      }
    },
    Error,
    "Permissions Violation for Publish",
  );
  await d;
  await cleanup(ns, nc);
});

Deno.test("mreq - sub permission error", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permissions: { subscribe: { deny: "_INBOX.>" } },
      }],
    },
  }, { user: "a", pass: "a" });

  nc.subscribe("q", {
    callback: (_err, msg) => {
      msg?.respond();
    },
  });

  const d = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (
        s.type === "error" &&
        s.error instanceof errors.PermissionViolationError &&
        s.error.operation === "subscription" &&
        s.error.subject.startsWith("_INBOX.")
      ) {
        d.resolve();
      }
    }
  })().then();

  await assertRejects(
    async () => {
      const iter = await nc.requestMany("q", Empty, {
        strategy: "count",
        maxMessages: 3,
        maxWait: 2000,
        noMux: true,
      });
      for await (const _m of iter) {
        // nothing;
      }
    },
    errors.PermissionViolationError,
    "Permissions Violation for Subscription",
  );
  await d;
  await cleanup(ns, nc);
});

Deno.test("mreq - lost sub permission", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
    },
  }, { user: "a", pass: "a" });

  let reloaded = false;
  nc.subscribe("q", {
    callback: (_err, msg) => {
      msg?.respond();
      if (!reloaded) {
        reloaded = true;
        ns.reload({
          authorization: {
            users: [{
              user: "a",
              password: "a",
              permissions: { subscribe: { deny: "_INBOX.>" } },
            }],
          },
        });
      }
    },
  });

  const d = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === "error") {
        if (
          s.error instanceof errors.PermissionViolationError &&
          s.error.operation === "subscription" &&
          s.error.subject.startsWith("_INBOX.")
        ) {
          d.resolve();
        }
      }
    }
  })().then();

  const iter = await nc.requestMany("q", Empty, {
    strategy: "count",
    maxMessages: 100,
    stall: 2000,
    maxWait: 2000,
    noMux: true,
  }) as QueuedIteratorImpl<Msg>;

  await assertRejects(
    () => {
      return (async () => {
        for await (const _m of iter) {
          // nothing;
        }
      })();
    },
    errors.PermissionViolationError,
    "Permissions Violation for Subscription",
  );

  await iter.iterClosed;
  await cleanup(ns, nc);
});

Deno.test("mreq - timeout doesn't leak subs", async () => {
  const { ns, nc } = await setup();

  nc.subscribe("q", { callback: () => {} });
  const nci = nc as NatsConnectionImpl;
  assertEquals(nci.protocol.subscriptions.size(), 1);

  // there's no error here - the empty response is the timeout
  const iter = await nc.requestMany("q", Empty, {
    maxWait: 1000,
    maxMessages: 10,
    noMux: true,
  });
  for await (const _ of iter) {
    // nothing
  }

  assertEquals(nci.protocol.subscriptions.size(), 1);
  await cleanup(ns, nc);
});

Deno.test("mreq - no responder doesn't leak subs", async () => {
  const { ns, nc } = await setup();

  const nci = nc as NatsConnectionImpl;
  assertEquals(nci.protocol.subscriptions.size(), 0);

  await assertRejects(
    async () => {
      const iter = await nc.requestMany("q", Empty, {
        noMux: true,
        maxWait: 1000,
        maxMessages: 10,
      });
      for await (const _ of iter) {
        // nothing
      }
    },
    errors.NoRespondersError,
    "no responders: 'q'",
  );

  // the mux subscription
  assertEquals(nci.protocol.subscriptions.size(), 0);
  await cleanup(ns, nc);
});

Deno.test("mreq - no mux request no perms doesn't leak subs", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "s",
        password: "s",
        permission: {
          publish: "q",
          subscribe: ">",
          allow_responses: true,
        },
      }],
    },
  }, { user: "s", pass: "s" });

  const nci = nc as NatsConnectionImpl;
  assertEquals(nci.protocol.subscriptions.size(), 0);

  await assertRejects(
    async () => {
      const iter = await nc.requestMany("qq", Empty, {
        noMux: true,
        maxWait: 1000,
      });
      for await (const _ of iter) {
        // nothing
      }
    },
    Error,
    "Permissions Violation for Publish",
  );

  await cleanup(ns, nc);
});

async function requestManyTracing(noMux: boolean) {
  const { ns, nc } = await setup();
  const sub = nc.subscribe("foo", {
    callback: (_, m) => {
      m.respond();
      m.respond();
    },
  });

  const traces = nc.subscribe("traces", {
    callback: () => {},
    max: 2,
  });
  nc.flush();

  let iter = await nc.requestMany("foo", Empty, {
    strategy: "stall",
    maxWait: 2_000,
    noMux,
    traceDestination: "traces",
  });
  let count = 0;
  for await (const _ of iter) {
    count++;
  }
  assertEquals(count, 2);

  iter = await nc.requestMany("foo", Empty, {
    strategy: "stall",
    maxWait: 2_000,
    noMux,
    traceDestination: "traces",
    traceOnly: true,
  });

  count = 0;
  for await (const _ of iter) {
    count++;
  }
  assertEquals(count, 0);

  await traces.closed;
  assertEquals(sub.getReceived(), 1);
  assertEquals(traces.getReceived(), 2);

  await cleanup(ns, nc);
}

Deno.test("basics - request many tracing", async () => {
  await requestManyTracing(false);
});

Deno.test("basics - request many tracing noMux", async () => {
  await requestManyTracing(true);
});

async function requestManyNoRespondersStack(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const iter = await nc.requestMany(createInbox(), Empty, {
    strategy: "timer",
    maxWait: 2000,
    noMux,
  });
  const err = await assertRejects(
    async () => {
      for await (const _m of iter) {
        // nothing
      }
    },
    errors.NoRespondersError,
  );
  // the stack points to the caller
  assertStringIncludes(err.stack || "", "mrequest_test");
  await cleanup(ns, nc);
}

Deno.test("mreq - no responders stack is useful", async () => {
  await requestManyNoRespondersStack();
});

Deno.test("mreq - no responders stack is useful noMux", async () => {
  await requestManyNoRespondersStack(true);
});

Deno.test("mreq - shared errors are not modified", async () => {
  const { ns, nc } = await setup({});
  const subj = createInbox();
  nc.subscribe(subj, { callback: () => {} });
  await nc.flush();

  // closing the connection fails every pending request with one error
  const iters = await Promise.all([
    nc.requestMany(subj, Empty, { strategy: "timer", maxWait: 5000 }),
    nc.requestMany(subj, Empty, { strategy: "timer", maxWait: 5000 }),
  ]);
  const errs = iters.map((iter) =>
    (async () => {
      for await (const _m of iter) {
        // nothing
      }
    })().then(() => fail("should have failed"), (err) => err as Error)
  );
  await nc.close();
  const [a, b] = await Promise.all(errs);
  assert(a === b);
  // nothing was appended to it by either request
  assertEquals(a.stack?.split("\n\n").length, 1);
  await cleanup(ns, nc);
});

// responder sends count numbered responses, optionally spaced by delay,
// done resolves when it sent them all
async function responder(
  nc: NatsConnection,
  count: number,
  spacing = 0,
): Promise<{ subj: string; done: Promise<void> }> {
  const subj = createInbox();
  const done = deferred<void>();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      (async () => {
        for (let i = 0; i < count; i++) {
          if (spacing && i > 0) {
            await delay(spacing);
          }
          msg.respond(`${i}`);
        }
      })().then(() => done.resolve());
    },
  });
  await nc.flush();
  return { subj, done };
}

async function collect(iter: AsyncIterable<Msg>): Promise<string[]> {
  const buf: string[] = [];
  for await (const m of iter) {
    buf.push(m.string());
  }
  return buf;
}

async function requestManyFn(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const { subj, done } = await responder(nc, 10);

  const iter = await nc.requestMany(subj, Empty, {
    strategy: (m) => {
      return m.string() !== "4";
    },
    maxWait: 5000,
    noMux,
  });
  const start = Date.now();
  // the message that ends the request is delivered
  assertEquals(await collect(iter), ["0", "1", "2", "3", "4"]);
  assert(Date.now() - start < 1000);
  // let the responder finish before closing
  await done;
  await cleanup(ns, nc);
}

Deno.test("mreq - strategy fn", async () => {
  await requestManyFn();
});

Deno.test("mreq - strategy fn noMux", async () => {
  await requestManyFn(true);
});

async function requestManyFnError(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const { subj, done } = await responder(nc, 10);

  const buf: string[] = [];
  const iter = await nc.requestMany(subj, Empty, {
    strategy: (m) => {
      return m.string() === "2" ? new Error("bad response") : true;
    },
    maxWait: 5000,
    noMux,
  });
  await assertRejects(
    async () => {
      for await (const m of iter) {
        buf.push(m.string());
      }
    },
    Error,
    "bad response",
  );
  assertEquals(buf, ["0", "1", "2"]);
  // let the responder finish before closing
  await done;
  await cleanup(ns, nc);
}

Deno.test("mreq - strategy fn error", async () => {
  await requestManyFnError();
});

Deno.test("mreq - strategy fn error noMux", async () => {
  await requestManyFnError(true);
});

async function requestManyFnThrows(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const { subj, done } = await responder(nc, 10);

  const buf: string[] = [];
  const iter = await nc.requestMany(subj, Empty, {
    strategy: (m) => {
      if (m.string() === "1") {
        throw new Error("boom");
      }
      return true;
    },
    maxWait: 5000,
    noMux,
  });
  await assertRejects(
    async () => {
      for await (const m of iter) {
        buf.push(m.string());
      }
    },
    Error,
    "boom",
  );
  assertEquals(buf, ["0", "1"]);
  // let the responder finish before closing
  await done;
  await cleanup(ns, nc);
}

Deno.test("mreq - strategy fn throws", async () => {
  await requestManyFnThrows();
});

Deno.test("mreq - strategy fn throws noMux", async () => {
  await requestManyFnThrows(true);
});

async function requestManyFns(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const { subj, done } = await responder(nc, 10);

  const calls: string[] = [];
  const iter = await nc.requestMany(subj, Empty, {
    strategy: [
      (m) => {
        calls.push(`a${m.string()}`);
        return true;
      },
      (m) => {
        calls.push(`b${m.string()}`);
        return m.string() !== "1";
      },
      (m) => {
        calls.push(`c${m.string()}`);
        return true;
      },
    ],
    maxWait: 5000,
    noMux,
  });
  assertEquals(await collect(iter), ["0", "1"]);
  // run in order, the first that stops ends the request
  assertEquals(calls, ["a0", "b0", "c0", "a1", "b1"]);
  // let the responder finish before closing
  await done;
  await cleanup(ns, nc);
}

Deno.test("mreq - strategy fns", async () => {
  await requestManyFns();
});

Deno.test("mreq - strategy fns noMux", async () => {
  await requestManyFns(true);
});

async function requestManyStallAnyStrategy(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const { subj, done } = await responder(nc, 3);

  const start = Date.now();
  const iter = await nc.requestMany(subj, Empty, {
    strategy: () => true,
    maxWait: 5000,
    stall: 250,
    noMux,
  });
  assertEquals(await collect(iter), ["0", "1", "2"]);
  // the stall ended it, not maxWait
  assert(Date.now() - start < 2000);
  // let the responder finish before closing
  await done;
  await cleanup(ns, nc);
}

Deno.test("mreq - stall works with any strategy", async () => {
  await requestManyStallAnyStrategy();
});

Deno.test("mreq - stall works with any strategy noMux", async () => {
  await requestManyStallAnyStrategy(true);
});

async function requestManyStallOption(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  // spaced past the 300ms default
  const { subj, done } = await responder(nc, 3, 600);

  const iter = await nc.requestMany(subj, Empty, {
    strategy: "stall",
    maxWait: 5000,
    stall: 2000,
    noMux,
  });
  assertEquals(await collect(iter), ["0", "1", "2"]);
  // let the responder finish before closing
  await done;
  await cleanup(ns, nc);
}

Deno.test("mreq - stall option", async () => {
  await requestManyStallOption();
});

Deno.test("mreq - stall option noMux", async () => {
  await requestManyStallOption(true);
});

async function requestManyPublishFails(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const nci = nc as NatsConnectionImpl;
  const subs = nci.protocol.subscriptions.size();
  const mux = nci.protocol.muxSubscriptions.size();

  const big = new Uint8Array(nci.info!.max_payload + 1);
  await assertRejects(
    () => {
      return nc.requestMany(createInbox(), big, {
        strategy: "timer",
        maxWait: 1000,
        noMux,
      });
    },
    errors.InvalidArgumentError,
    "max_payload size exceeded",
  );
  // nothing is left behind - mux creates its shared inbox sub on first use
  assertEquals(nci.protocol.subscriptions.size(), noMux ? subs : subs + 1);
  assertEquals(nci.protocol.muxSubscriptions.size(), mux);
  await cleanup(ns, nc);
}

Deno.test("mreq - publish failure rejects", async () => {
  await requestManyPublishFails();
});

Deno.test("mreq - publish failure rejects noMux", async () => {
  await requestManyPublishFails(true);
});

async function requestManyMaxWaitCaps(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  // responses keep arriving well within the stall for 3s
  const { subj, done } = await responder(nc, 15, 200);

  const start = Date.now();
  const iter = await nc.requestMany(subj, Empty, {
    strategy: "stall",
    stall: 500,
    maxWait: 1000,
    noMux,
  });
  const buf = await collect(iter);
  const elapsed = Date.now() - start;
  // maxWait is the upper bound, the stall doesn't extend it
  assert(elapsed < 1600, `elapsed ${elapsed}`);
  assert(buf.length > 0 && buf.length < 15, `got ${buf.length}`);
  // let the responder finish before closing
  await done;
  await cleanup(ns, nc);
}

Deno.test("mreq - maxWait caps the request", async () => {
  await requestManyMaxWaitCaps();
});

Deno.test("mreq - maxWait caps the request noMux", async () => {
  await requestManyMaxWaitCaps(true);
});

async function requestManyTimeout(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const subj = createInbox();
  nc.subscribe(subj, { callback: () => {} });
  await nc.flush();

  const start = Date.now();
  const iter = await nc.requestMany(subj, Empty, {
    strategy: "timer",
    timeout: 300,
    maxWait: 5000,
    noMux,
  });
  await assertRejects(
    () => {
      return collect(iter);
    },
    errors.TimeoutError,
  );
  assert(Date.now() - start < 2000);
  await cleanup(ns, nc);
}

Deno.test("mreq - timeout fails if no response arrives", async () => {
  await requestManyTimeout();
});

Deno.test("mreq - timeout fails if no response arrives noMux", async () => {
  await requestManyTimeout(true);
});

async function requestManyTimeoutOnlyFirst(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  // responses after the first are spaced past the timeout
  const { subj, done } = await responder(nc, 4, 400);

  const iter = await nc.requestMany(subj, Empty, {
    strategy: "count",
    maxMessages: 4,
    timeout: 200,
    maxWait: 5000,
    noMux,
  });
  assertEquals(await collect(iter), ["0", "1", "2", "3"]);
  // let the responder finish before closing
  await done;
  await cleanup(ns, nc);
}

Deno.test("mreq - timeout only applies to the first response", async () => {
  await requestManyTimeoutOnlyFirst();
});

Deno.test("mreq - timeout only applies to the first response noMux", async () => {
  await requestManyTimeoutOnlyFirst(true);
});

async function requestManyUnbounded(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  // past the default maxWait
  const { subj, done } = await responder(nc, 2, 1200);

  const start = Date.now();
  const iter = await nc.requestMany(subj, Empty, {
    strategy: "count",
    maxMessages: 2,
    maxWait: Infinity,
    noMux,
  });
  assertEquals(await collect(iter), ["0", "1"]);
  assert(Date.now() - start >= 1200);
  // let the responder finish before closing
  await done;
  await cleanup(ns, nc);
}

Deno.test("mreq - maxWait Infinity is unbounded", async () => {
  await requestManyUnbounded();
});

Deno.test("mreq - maxWait Infinity is unbounded noMux", async () => {
  await requestManyUnbounded(true);
});

Deno.test("mreq - timer options are validated", async () => {
  const { ns, nc } = await setup({});
  const bad: [Partial<RequestManyOptions>, string][] = [
    [{ timeout: 0 }, "'timeout' must be at least 1 and less than maxWait"],
    [{ timeout: -1 }, "'timeout' must be at least 1 and less than maxWait"],
    [{ timeout: NaN }, "'timeout' must be at least 1 and less than maxWait"],
    [
      { timeout: Infinity },
      "'timeout' must be at least 1 and less than maxWait",
    ],
    [
      { timeout: 1000, maxWait: 1000 },
      "'timeout' must be at least 1 and less than maxWait",
    ],
  ];
  for (const [opts, msg] of bad) {
    await assertRejects(
      () => {
        return nc.requestMany(createInbox(), Empty, opts);
      },
      errors.InvalidArgumentError,
      msg,
    );
  }
  await cleanup(ns, nc);
});

async function requestManyStallIgnored(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  // spaced past any stall that would fire
  const { subj, done } = await responder(nc, 2, 400);
  for (
    const opts of [
      { stall: 0, maxWait: 2000 },
      { stall: -1, maxWait: 2000 },
      { stall: 2000, maxWait: 2000 },
      { stall: Infinity, maxWait: Infinity },
    ]
  ) {
    const iter = await nc.requestMany(subj, Empty, {
      strategy: "count",
      maxMessages: 2,
      noMux,
      ...opts,
    });
    assertEquals(await collect(iter), ["0", "1"], JSON.stringify(opts));
  }
  await done;
  await cleanup(ns, nc);
}

Deno.test("mreq - stall that can't fire is ignored", async () => {
  await requestManyStallIgnored();
});

Deno.test("mreq - stall that can't fire is ignored noMux", async () => {
  await requestManyStallIgnored(true);
});

async function requestManyStallDefaultIgnored(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const subj = createInbox();
  nc.subscribe(subj, { callback: () => {} });
  await nc.flush();
  // the 300 default can't fire before maxWait, the request still works
  const start = Date.now();
  const iter = await nc.requestMany(subj, Empty, {
    strategy: "stall",
    maxWait: 200,
    noMux,
  });
  assertEquals(await collect(iter), []);
  assert(Date.now() - start >= 200);
  await cleanup(ns, nc);
}

Deno.test("mreq - stall default larger than maxWait is ignored", async () => {
  await requestManyStallDefaultIgnored();
});

Deno.test("mreq - stall default larger than maxWait is ignored noMux", async () => {
  await requestManyStallDefaultIgnored(true);
});

async function requestManyTimeoutStack(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const subj = createInbox();
  nc.subscribe(subj, { callback: () => {} });
  await nc.flush();
  const iter = await nc.requestMany(subj, Empty, {
    timeout: 250,
    maxWait: 2000,
    noMux,
  });
  const err = await assertRejects(
    () => {
      return collect(iter);
    },
    errors.TimeoutError,
  );
  // the stack points to the caller
  assertStringIncludes(err.stack || "", "mrequest_test");
  await cleanup(ns, nc);
}

Deno.test("mreq - timeout stack is useful", async () => {
  await requestManyTimeoutStack();
});

Deno.test("mreq - timeout stack is useful noMux", async () => {
  await requestManyTimeoutStack(true);
});

async function requestManyTimeoutNoResponders(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const iter = await nc.requestMany(createInbox(), Empty, {
    timeout: 1000,
    maxWait: 2000,
    noMux,
  });
  // no responders is reported, not a timeout
  await assertRejects(
    () => {
      return collect(iter);
    },
    errors.NoRespondersError,
  );
  await cleanup(ns, nc);
}

Deno.test("mreq - timeout with no responders", async () => {
  await requestManyTimeoutNoResponders();
});

Deno.test("mreq - timeout with no responders noMux", async () => {
  await requestManyTimeoutNoResponders(true);
});

async function requestManyClose(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const subj = createInbox();
  nc.subscribe(subj, { callback: () => {} });
  await nc.flush();
  const iter = await nc.requestMany(subj, Empty, {
    strategy: "timer",
    maxWait: 5000,
    noMux,
  });
  const p = collect(iter);
  await nc.close();
  await assertRejects(
    () => {
      return p;
    },
    errors.RequestError,
    "connection closed",
  );
  await cleanup(ns, nc);
}

Deno.test("mreq - close ends the request with an error", async () => {
  await requestManyClose();
});

Deno.test("mreq - close ends the request with an error noMux", async () => {
  await requestManyClose(true);
});

async function requestManyCloseTimers(noMux = false): Promise<void> {
  const { ns, nc } = await setup({});
  const subj = createInbox();
  nc.subscribe(subj, { callback: () => {} });
  await nc.flush();
  // never iterated - the close must clear the timers, or the test leaks
  await nc.requestMany(subj, Empty, {
    strategy: "timer",
    maxWait: 5000,
    timeout: 3000,
    stall: 1000,
    noMux,
  });
  await nc.close();
  await cleanup(ns, nc);
}

Deno.test("mreq - close clears timers", async () => {
  await requestManyCloseTimers();
});

Deno.test("mreq - close clears timers noMux", async () => {
  await requestManyCloseTimers(true);
});
