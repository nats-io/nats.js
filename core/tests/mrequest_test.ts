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
import { cleanup, setup } from "test_helpers";
import type {
  Msg,
  NatsConnectionImpl,
  QueuedIteratorImpl,
} from "../src/internal_mod.ts";
import { createInbox, deferred, delay, Empty } from "../src/internal_mod.ts";

import { assert, assertEquals, assertRejects, fail } from "jsr:@std/assert";
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

Deno.test("basics - request many tracing", async () => {
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
});
