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
  assertExists,
  assertInstanceOf,
  assertRejects,
  assertThrows,
  fail,
} from "jsr:@std/assert";

import {
  collect,
  createInbox,
  deferred,
  delay,
  Empty,
  Feature,
  headers,
  isIP,
  nuid,
  syncIterator,
} from "../src/internal_mod.ts";
import type {
  ConnectionClosedListener,
  Deferred,
  Msg,
  MsgHdrs,
  MsgImpl,
  NatsConnectionImpl,
  Payload,
  Publisher,
  PublishOptions,
  SubscriptionImpl,
} from "../src/internal_mod.ts";
import { cleanup, Lock, NatsServer, setup } from "test_helpers";
import { connect } from "./connect.ts";
import { errors } from "../src/errors.ts";

Deno.test("basics - connect port", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  await cleanup(ns, nc);
});

Deno.test("basics - connect default", async () => {
  const ns = await NatsServer.start({ port: 4222 });
  const nc = await connect({});
  await cleanup(ns, nc);
});

Deno.test("basics - connect host", async () => {
  const nc = await connect({ servers: "demo.nats.io" });
  await nc.close();
});

Deno.test("basics - connect hostport", async () => {
  const nc = await connect({ servers: "demo.nats.io:4222" });
  await nc.close();
});

Deno.test("basics - connect servers", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ servers: [`${ns.hostname}:${ns.port}`] });
  await cleanup(ns, nc);
});

Deno.test("basics - fail connect", async () => {
  await assertRejects(
    () => {
      return connect({ servers: `127.0.0.1:32001` });
    },
    errors.ConnectionError,
    "connection refused",
  );
});

Deno.test("basics - publish", async () => {
  const { ns, nc } = await setup();
  nc.publish(createInbox());
  await nc.flush();
  await cleanup(ns, nc);
});

Deno.test("basics - no publish without subject", async () => {
  const { ns, nc } = await setup();
  assertThrows(
    () => {
      nc.publish("");
    },
    errors.InvalidSubjectError,
    "illegal subject: ''",
  );
  await cleanup(ns, nc);
});

Deno.test("basics - pubsub", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  const iter = (async () => {
    for await (const _m of sub) {
      break;
    }
  })();

  nc.publish(subj);
  await iter;
  assertEquals(sub.getProcessed(), 1);
  await cleanup(ns, nc);
});

Deno.test("basics - subscribe and unsubscribe", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;
  const subj = createInbox();
  const sub = nc.subscribe(subj, { max: 1000, queue: "aaa" });

  // check the subscription
  assertEquals(nci.protocol.subscriptions.size(), 1);
  let s = nci.protocol.subscriptions.get(1);
  assert(s);
  assertEquals(s.getReceived(), 0);
  assertEquals(s.subject, subj);
  assert(s.callback);
  assertEquals(s.max, 1000);
  assertEquals(s.queue, "aaa");

  // modify the subscription
  sub.unsubscribe(10);
  s = nci.protocol.subscriptions.get(1);
  assert(s);
  assertEquals(s.max, 10);

  // verify subscription updates on message
  nc.publish(subj);
  await nc.flush();
  s = nci.protocol.subscriptions.get(1);
  assert(s);
  assertEquals(s.getReceived(), 1);

  // verify cleanup
  sub.unsubscribe();
  assertEquals(nci.protocol.subscriptions.size(), 0);
  await cleanup(ns, nc);
});

Deno.test("basics - subscriptions iterate", async () => {
  const { ns, nc } = await setup();
  const lock = Lock();
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  (async () => {
    for await (const _m of sub) {
      lock.unlock();
    }
  })().then();
  nc.publish(subj);
  await nc.flush();
  await lock;
  await cleanup(ns, nc);
});

Deno.test("basics - subscriptions pass exact subject to cb", async () => {
  const { ns, nc } = await setup();
  const s = createInbox();
  const subj = `${s}.foo.bar.baz`;
  const sub = nc.subscribe(`${s}.*.*.*`);
  const sp = deferred<string>();
  (async () => {
    for await (const m of sub) {
      sp.resolve(m.subject);
      break;
    }
  })().then();
  nc.publish(subj);
  assertEquals(await sp, subj);
  await cleanup(ns, nc);
});

Deno.test("basics - subscribe returns Subscription", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  assertEquals(sub.getID(), 1);
  await cleanup(ns, nc);
});

Deno.test("basics - wildcard subscriptions", async () => {
  const { ns, nc } = await setup();

  const single = 3;
  const partial = 2;
  const full = 5;

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
  assertEquals(sub.getReceived(), single, "single");
  assertEquals(sub2.getReceived(), partial, "partial");
  assertEquals(sub3.getReceived(), full, "full");
  await ns.stop();
});

Deno.test("basics - correct data in message", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const mp = deferred<Msg>();
  const sub = nc.subscribe(subj);
  (async () => {
    for await (const m of sub) {
      mp.resolve(m);
      break;
    }
  })().then();

  nc.publish(subj, subj);
  const m = await mp;
  assertEquals(m.subject, subj);
  assertEquals(m.string(), subj);
  assertEquals(m.reply, "");
  await cleanup(ns, nc);
});

Deno.test("basics - correct reply in message", async () => {
  const { ns, nc } = await setup();
  const s = createInbox();
  const r = createInbox();

  const rp = deferred<string>();
  const sub = nc.subscribe(s);
  (async () => {
    for await (const m of sub) {
      rp.resolve(m.reply);
      break;
    }
  })().then();
  nc.publish(s, Empty, { reply: r });
  assertEquals(await rp, r);
  await cleanup(ns, nc);
});

Deno.test("basics - respond returns false if no reply subject set", async () => {
  const { ns, nc } = await setup();
  const s = createInbox();
  const dr = deferred<boolean>();
  const sub = nc.subscribe(s);
  (async () => {
    for await (const m of sub) {
      dr.resolve(m.respond());
      break;
    }
  })().then();
  nc.publish(s);
  const failed = await dr;
  assert(!failed);
  await cleanup(ns, nc);
});

Deno.test("basics - closed cannot subscribe", async () => {
  const { ns, nc } = await setup();
  await nc.close();
  let failed = false;
  try {
    nc.subscribe(createInbox());
    fail("should have not been able to subscribe");
  } catch (_err) {
    failed = true;
  }
  assert(failed);
  await ns.stop();
});

Deno.test("basics - close cannot request", async () => {
  const { ns, nc } = await setup();
  await nc.close();
  let failed = false;
  try {
    await nc.request(createInbox());
    fail("should have not been able to request");
  } catch (_err) {
    failed = true;
  }
  assert(failed);
  await ns.stop();
});

Deno.test("basics - flush returns promise", async () => {
  const { ns, nc } = await setup();
  const p = nc.flush();
  if (!p) {
    fail("should have returned a promise");
  }
  await p;
  await cleanup(ns, nc);
});

Deno.test("basics - unsubscribe after close", async () => {
  const { ns, nc } = await setup();
  const sub = nc.subscribe(createInbox());
  await nc.close();
  sub.unsubscribe();
  await ns.stop();
});

Deno.test("basics - unsubscribe stops messages", async () => {
  const { ns, nc } = await setup();
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
  assertEquals(sub.getReceived(), 1);
  await cleanup(ns, nc);
});

Deno.test("basics - request", async () => {
  const { ns, nc } = await setup();
  const s = createInbox();
  const sub = nc.subscribe(s);
  (async () => {
    for await (const m of sub) {
      m.respond("foo");
    }
  })().then();
  const msg = await nc.request(s);
  assertEquals(msg.string(), "foo");
  await cleanup(ns, nc);
});

Deno.test("basics - request no responders", async () => {
  const { ns, nc } = await setup();
  await assertRejects(
    () => {
      return nc.request("q", Empty, { timeout: 100 });
    },
    errors.RequestError,
    "no responders: 'q'",
  );

  await cleanup(ns, nc);
});

Deno.test("basics - request no responders noMux", async () => {
  const { ns, nc } = await setup();
  await assertRejects(
    () => {
      return nc.request("q", Empty, { timeout: 100, noMux: true });
    },
    errors.RequestError,
    "no responders: 'q'",
  );
  await cleanup(ns, nc);
});

Deno.test("basics - request timeout", async () => {
  const { ns, nc } = await setup();
  const s = createInbox();
  nc.subscribe(s, { callback: () => {} });
  await assertRejects(() => {
    return nc.request(s, Empty, { timeout: 100 });
  }, errors.TimeoutError);

  await cleanup(ns, nc);
});

Deno.test("basics - request timeout noMux", async () => {
  const { ns, nc } = await setup();
  const s = createInbox();
  nc.subscribe(s, { callback: () => {} });
  await assertRejects(() => {
    return nc.request(s, Empty, { timeout: 100, noMux: true });
  }, errors.TimeoutError);

  await cleanup(ns, nc);
});

Deno.test("basics - request cancel rejects", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;
  const s = createInbox();

  const check = assertRejects(
    () => {
      return nc.request(s, Empty, { timeout: 1000 });
    },
    errors.RequestError,
    "cancelled",
  );

  nci.protocol.muxSubscriptions.reqs.forEach((v) => {
    v.cancel();
  });

  await check;
  await cleanup(ns, nc);
});

Deno.test("basics - old style requests", async () => {
  const { ns, nc } = await setup();
  nc.subscribe("q", {
    callback: (_err, msg) => {
      msg.respond("hello");
    },
  });

  const m = await nc.request(
    "q",
    Empty,
    { reply: "bar", noMux: true, timeout: 1000 },
  );
  assertEquals("hello", m.string());
  assertEquals("bar", m.subject);

  await cleanup(ns, nc);
});

Deno.test("basics - reply can only be used with noMux", async () => {
  const { ns, nc } = await setup();
  nc.subscribe("q", {
    callback: (_err, msg) => {
      msg.respond("hello");
    },
  });

  await assertRejects(
    () => {
      return nc.request("q", Empty, { reply: "bar", timeout: 1000 });
    },
    errors.InvalidArgumentError,
    "'reply','noMux' are mutually exclusive",
  );

  await cleanup(ns, nc);
});

Deno.test("basics - request with headers", async () => {
  const { ns, nc } = await setup();
  const s = createInbox();
  const sub = nc.subscribe(s);
  (async () => {
    for await (const m of sub) {
      const headerContent = m.headers?.get("test-header");
      m.respond(`header content: ${headerContent}`);
    }
  })().then();
  const requestHeaders = headers();
  requestHeaders.append("test-header", "Hello, world!");
  const msg = await nc.request(s, Empty, {
    headers: requestHeaders,
    timeout: 5000,
  });
  assertEquals(msg.string(), "header content: Hello, world!");
  await cleanup(ns, nc);
});

Deno.test("basics - request with headers and custom subject", async () => {
  const { ns, nc } = await setup();
  const s = createInbox();
  const sub = nc.subscribe(s);
  (async () => {
    for await (const m of sub) {
      const headerContent = m.headers?.get("test-header");
      m.respond(`header content: ${headerContent}`);
    }
  })().then();
  const requestHeaders = headers();
  requestHeaders.append("test-header", "Hello, world!");
  const msg = await nc.request(s, Empty, {
    headers: requestHeaders,
    timeout: 5000,
    reply: "reply-subject",
    noMux: true,
  });
  assertEquals(msg.string(), "header content: Hello, world!");
  await cleanup(ns, nc);
});

Deno.test("basics - request requires a subject", async () => {
  const { ns, nc } = await setup();
  await assertRejects(
    () => {
      //@ts-ignore: testing
      return nc.request();
    },
    errors.InvalidSubjectError,
    "illegal subject: ''",
  );
  await cleanup(ns, nc);
});

Deno.test("basics - closed returns error", async () => {
  const { ns, nc } = await setup({}, { reconnect: false });
  setTimeout(() => {
    (nc as NatsConnectionImpl).protocol.sendCommand("Y\r\n");
  }, 100);
  const done = await nc.closed();
  assertInstanceOf(done, errors.ProtocolError);
  await cleanup(ns, nc);
});

Deno.test("basics - subscription with timeout", async () => {
  const { ns, nc } = await setup();
  const sub = nc.subscribe(createInbox(), { max: 1, timeout: 250 });
  await assertRejects(
    async () => {
      for await (const _m of sub) {
        // ignored
      }
    },
    errors.TimeoutError,
    "timeout",
  );
  await cleanup(ns, nc);
});

Deno.test("basics - subscription expecting 2 doesn't fire timeout", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const sub = nc.subscribe(subj, { max: 2, timeout: 500 });
  (async () => {
    for await (const _m of sub) {
      // ignored
    }
  })().catch((err) => {
    fail(err);
  });

  nc.publish(subj);
  await nc.flush();
  await delay(1000);

  assertEquals(sub.getReceived(), 1);
  await cleanup(ns, nc);
});

Deno.test("basics - subscription timeout auto cancels", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  let c = 0;
  const sub = nc.subscribe(subj, { max: 2, timeout: 300 });
  (async () => {
    for await (const _m of sub) {
      c++;
    }
  })().catch((err) => {
    fail(err);
  });

  nc.publish(subj);
  nc.publish(subj);
  await delay(500);
  assertEquals(c, 2);
  await cleanup(ns, nc);
});

Deno.test("basics - no mux requests create normal subs", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;
  nc.request(createInbox(), Empty, { timeout: 1000, noMux: true }).then();
  assertEquals(nci.protocol.subscriptions.size(), 1);
  assertEquals(nci.protocol.muxSubscriptions.size(), 0);
  const sub = nci.protocol.subscriptions.get(1);
  assert(sub);
  assertEquals(sub.max, 1);
  sub.unsubscribe();
  assertEquals(nci.protocol.subscriptions.size(), 0);
  await cleanup(ns, nc);
});

Deno.test("basics - no mux requests timeout", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  nc.subscribe(subj, { callback: () => {} });
  await assertRejects(
    () => {
      return nc.request(subj, Empty, { timeout: 500, noMux: true });
    },
    errors.TimeoutError,
  );

  await cleanup(ns, nc);
});

Deno.test("basics - no mux requests", async () => {
  const { ns, nc } = await setup({ max_payload: 2048 });
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  const data = Uint8Array.from([1234]);
  (async () => {
    for await (const m of sub) {
      m.respond(data);
    }
  })().then();

  const m = await nc.request(subj, Empty, { timeout: 1000, noMux: true });
  assertEquals(m.data, data);
  await cleanup(ns, nc);
});

Deno.test("basics - no mux request timeout doesn't leak subs", async () => {
  const { ns, nc } = await setup();

  nc.subscribe("q", { callback: () => {} });
  const nci = nc as NatsConnectionImpl;
  assertEquals(nci.protocol.subscriptions.size(), 1);

  await assertRejects(
    () => {
      return nc.request("q", Empty, { noMux: true, timeout: 1000 });
    },
    errors.TimeoutError,
  );

  assertEquals(nci.protocol.subscriptions.size(), 1);
  await cleanup(ns, nc);
});

Deno.test("basics - no mux request no responders doesn't leak subs", async () => {
  const { ns, nc } = await setup();

  const nci = nc as NatsConnectionImpl;
  assertEquals(nci.protocol.subscriptions.size(), 0);
  await assertRejects(() => {
    return nc.request("q", Empty, { noMux: true, timeout: 500 });
  });

  assertEquals(nci.protocol.subscriptions.size(), 0);
  await cleanup(ns, nc);
});

Deno.test("basics - no mux request no perms doesn't leak subs", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "s",
        password: "s",
        permission: {
          publish: "q",
          subscribe: "response",
          allow_responses: true,
        },
      }],
    },
  }, { user: "s", pass: "s" });

  const nci = nc as NatsConnectionImpl;
  assertEquals(nci.protocol.subscriptions.size(), 0);

  await assertRejects(
    async () => {
      await nc.request("qq", Empty, {
        noMux: true,
        reply: "response",
        timeout: 1000,
      });
    },
    Error,
    "Permissions Violation for Publish",
  );

  await assertRejects(
    async () => {
      await nc.request("q", Empty, { noMux: true, reply: "r", timeout: 1000 });
    },
    Error,
    "Permissions Violation for Subscription",
  );

  assertEquals(nci.protocol.subscriptions.size(), 0);
  await cleanup(ns, nc);
});

Deno.test("basics - max_payload errors", async () => {
  const { ns, nc } = await setup({ max_payload: 2048 });
  const nci = nc as NatsConnectionImpl;
  assert(nci.protocol.info);
  const big = new Uint8Array(nci.protocol.info.max_payload + 1);

  assertThrows(
    () => {
      nc.publish("foo", big);
    },
    errors.InvalidArgumentError,
    `payload size exceeded`,
  );

  assertRejects(
    () => {
      return nc.request("foo", big);
    },
    errors.InvalidArgumentError,
    `payload size exceeded`,
  );

  const d = deferred();
  setTimeout(() => {
    nc.request("foo").catch((err) => {
      d.reject(err);
    });
  });

  const sub = nc.subscribe("foo");

  for await (const m of sub) {
    assertThrows(
      () => {
        m.respond(big);
      },
      errors.InvalidArgumentError,
      `payload size exceeded`,
    );
    break;
  }

  await assertRejects(
    () => {
      return d;
    },
    errors.TimeoutError,
    "timeout",
  );

  await cleanup(ns, nc);
});

Deno.test("basics - close cancels requests", async () => {
  const { ns, nc } = await setup();
  nc.subscribe("q", { callback: () => {} });

  const done = assertRejects(
    () => {
      return nc.request("q");
    },
    errors.RequestError,
    "connection closed",
  );

  await nc.close();
  await done;

  await cleanup(ns, nc);
});

Deno.test("basics - empty message", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const mp = deferred<Msg>();
  const sub = nc.subscribe(subj);
  (async () => {
    for await (const m of sub) {
      mp.resolve(m);
      break;
    }
  })().then();

  nc.publish(subj);
  const m = await mp;
  assertEquals(m.subject, subj);
  assertEquals(m.data.length, 0);
  await cleanup(ns, nc);
});

Deno.test("basics - msg buffers dont overwrite", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;
  const N = 100;
  const sub = nc.subscribe(">");
  const msgs: Msg[] = [];
  (async () => {
    for await (const m of sub) {
      msgs.push(m);
    }
  })().then();

  const a = "a".charCodeAt(0);
  const fill = (n: number, b: Uint8Array) => {
    const v = n % 26 + a;
    for (let i = 0; i < b.length; i++) {
      b[i] = v;
    }
  };
  const td = new TextDecoder();
  assert(nci.protocol.info);
  const buf = new Uint8Array(nci.protocol.info.max_payload);
  for (let i = 0; i < N; i++) {
    fill(i, buf);
    const subj = td.decode(buf.subarray(0, 26));
    nc.publish(subj, buf, { reply: subj });
    await nc.flush();
  }

  await nc.drain();
  await ns.stop();

  const check = (n: number, m: Msg) => {
    const v = n % 26 + a;
    assert(nci.protocol.info);
    assertEquals(m.data.length, nci.protocol.info.max_payload);
    for (let i = 0; i < m.data.length; i++) {
      if (m.data[i] !== v) {
        fail(
          `failed on iteration ${i} - expected ${String.fromCharCode(v)} got ${
            String.fromCharCode(m.data[i])
          }`,
        );
      }
    }
    assertEquals(m.subject, td.decode(m.data.subarray(0, 26)), "subject check");
    assertEquals(m.reply, td.decode(m.data.subarray(0, 26)), "reply check");
  };

  assertEquals(msgs.length, N);
  for (let i = 0; i < N; i++) {
    check(i, msgs[i]);
  }
});

Deno.test("basics - get client ip", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ servers: `localhost:${ns.port}` });
  const ip = nc.info?.client_ip || "";
  assertEquals(isIP(ip), true);
  await nc.close();
  assert(nc.info === undefined);
  await ns.stop();
});

Deno.test("basics - subs pending count", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();

  const sub = nc.subscribe(subj, { max: 10 });
  const done = (async () => {
    let count = 0;
    for await (const _m of sub) {
      count++;
      assertEquals(count, sub.getProcessed());
      console.log({ processed: sub.getProcessed(), pending: sub.getPending() });
      assertEquals(sub.getProcessed() + sub.getPending(), 10);
    }
  })();

  for (let i = 0; i < 10; i++) {
    nc.publish(subj);
  }
  await nc.flush();
  await done;
  await cleanup(ns, nc);
});

Deno.test("basics - create inbox", () => {
  type inout = [string, string, boolean?];
  const t: inout[] = [];
  t.push(["", "_INBOX."]);
  //@ts-ignore testing
  t.push([undefined, "_INBOX."]);
  //@ts-ignore testing
  t.push([null, "_INBOX."]);
  //@ts-ignore testing
  t.push([5, "5.", true]);
  t.push(["hello", "hello."]);

  t.forEach((v, index) => {
    if (v[2]) {
      assertThrows(() => {
        createInbox(v[0]);
      });
    } else {
      const out = createInbox(v[0]);
      assert(out.startsWith(v[1]), `test ${index}`);
    }
  });
});

Deno.test("basics - custom prefix", async () => {
  const { ns, nc } = await setup({}, { inboxPrefix: "_x" });
  const subj = createInbox();
  nc.subscribe(subj, {
    max: 1,
    callback: (_err, msg) => {
      msg.respond();
    },
  });

  const v = await nc.request(subj);
  assert(v.subject.startsWith("_x."));
  await cleanup(ns, nc);
});

Deno.test("basics - custom prefix noMux", async () => {
  const { ns, nc } = await setup({}, { inboxPrefix: "_y" });
  const subj = createInbox();
  nc.subscribe(subj, {
    max: 1,
    callback: (_err, msg) => {
      msg.respond();
    },
  });

  const v = await nc.request(subj);
  assert(v.subject.startsWith("_y."));
  await cleanup(ns, nc);
});

Deno.test("basics - debug", async () => {
  const { ns, nc } = await setup({}, { debug: true });
  await nc.flush();
  await cleanup(ns, nc);
  assertEquals(nc.isClosed(), true);
});

Deno.test("basics - subscription with timeout cancels on message", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const sub = nc.subscribe(subj, { max: 1, timeout: 500 }) as SubscriptionImpl;
  assert(sub.timer !== undefined);
  const done = (async () => {
    for await (const _m of sub) {
      assertEquals(sub.timer, undefined);
    }
  })();
  nc.publish(subj);
  await done;
  await cleanup(ns, nc);
});

Deno.test("basics - subscription cb with timeout cancels on message", async () => {
  const { ns, nc } = await setup();
  const subj = createInbox();
  const done = Lock();
  const sub = nc.subscribe(subj, {
    max: 1,
    timeout: 500,
    callback: () => {
      done.unlock();
    },
  }) as SubscriptionImpl;
  assert(sub.timer !== undefined);
  nc.publish(subj);
  await done;
  assertEquals(sub.timer, undefined);
  await cleanup(ns, nc);
});

Deno.test("basics - resolve", async () => {
  const nci = await connect({
    servers: "demo.nats.io",
  }) as NatsConnectionImpl;

  await nci.flush();
  const srv = nci.protocol.servers.getCurrentServer();
  assert(srv.resolves && srv.resolves.length > 1);
  await nci.close();
});

Deno.test("basics - port and server are mutually exclusive", async () => {
  await assertRejects(
    async () => {
      await connect({ servers: "localhost", port: 4222 });
    },
    errors.InvalidArgumentError,
    "'servers','port' are mutually exclusive",
    undefined,
  );
});

Deno.test("basics - rtt", async () => {
  const { ns, nc } = await setup({}, {
    maxReconnectAttempts: 1,
    reconnectTimeWait: 750,
  });
  const rtt = await nc.rtt();
  assert(rtt >= 0);

  await ns.stop();

  await assertRejects(
    () => {
      return nc.rtt();
    },
    errors.RequestError,
    "disconnected",
  );

  await nc.closed();

  await assertRejects(() => {
    return nc.rtt();
  }, errors.ClosedConnectionError);
});

Deno.test("basics - request many count", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;

  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      for (let i = 0; i < 5; i++) {
        msg.respond();
      }
    },
  });

  const lock = Lock(5, 2000);

  const iter = await nci.requestMany(subj, Empty, {
    strategy: "count",
    maxWait: 2000,
    maxMessages: 5,
  });
  for await (const mer of iter) {
    if (mer instanceof Error) {
      fail(mer.message);
    }
    lock.unlock();
  }
  await lock;

  await cleanup(ns, nc);
});

Deno.test("basics - request many jitter", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;

  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      for (let i = 0; i < 10; i++) {
        msg.respond();
      }
    },
  });

  let count = 0;
  const start = Date.now();
  const iter = await nci.requestMany(subj, Empty, {
    strategy: "stall",
    maxWait: 5000,
  });
  for await (const mer of iter) {
    if (mer instanceof Error) {
      fail(mer.message);
    }
    count++;
  }
  const time = Date.now() - start;
  assert(500 > time);
  assertEquals(count, 10);
  await cleanup(ns, nc);
});

Deno.test("basics - request many sentinel", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;

  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      for (let i = 0; i < 10; i++) {
        msg.respond("hello");
      }
      msg.respond();
    },
  });

  let count = 0;
  const start = Date.now();
  const iter = await nci.requestMany(subj, Empty, {
    strategy: "sentinel",
    maxWait: 2000,
  });
  for await (const mer of iter) {
    if (mer instanceof Error) {
      fail(mer.message);
    }
    count++;
  }
  const time = Date.now() - start;
  assert(500 > time);
  assertEquals(count, 11);
  await cleanup(ns, nc);
});

Deno.test("basics - request many sentinel - partial response", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;

  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      for (let i = 0; i < 10; i++) {
        msg.respond("hello");
      }
    },
  });

  let count = 0;
  const start = Date.now();
  const iter = await nci.requestMany(subj, Empty, {
    strategy: "sentinel",
    maxWait: 2000,
  });
  for await (const mer of iter) {
    if (mer instanceof Error) {
      fail(mer.message);
    }
    count++;
  }
  const time = Date.now() - start;
  assert(time >= 2000);
  assertEquals(count, 10);
  await cleanup(ns, nc);
});

Deno.test("basics - request many wait for timer - no respone", async () => {
  const { ns, nc } = await setup();
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
});

Deno.test("basics - request many waits for timer late response", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;

  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      delay(1759).then(() => msg.respond());
    },
  });

  let count = 0;
  const start = Date.now();
  const iter = await nci.requestMany(subj, Empty, {
    strategy: "timer",
    maxWait: 2000,
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
});

Deno.test("basics - server version", async () => {
  const { ns, nc } = await setup();
  const nci = nc as NatsConnectionImpl;
  assertEquals(nci.protocol.features.require("3.0.0"), false);
  assertEquals(nci.protocol.features.require("2.8.2"), true);

  const ok = nci.features.require("2.8.3");
  const bytes = nci.features.get(Feature.JS_PULL_MAX_BYTES);
  assertEquals(ok, bytes.ok);
  assertEquals(bytes.min, "2.8.3");
  assertEquals(ok, nci.protocol.features.supports(Feature.JS_PULL_MAX_BYTES));

  await cleanup(ns, nc);
});

Deno.test("basics - info", async () => {
  const { ns, nc } = await setup();
  assertExists(nc.info);
  await cleanup(ns, nc);
});

Deno.test("basics - initial connect error", async () => {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const INFO = new TextEncoder().encode(
    `INFO {"server_id":"FAKE","server_name":"FAKE","version":"2.9.4","proto":1,"go":"go1.19.2","host":"127.0.0.1","port":${port},"headers":true,"max_payload":1048576,"jetstream":true,"client_id":4,"client_ip":"127.0.0.1"}\r\n`,
  );

  const done = (async () => {
    for await (const conn of listener) {
      await conn.write(INFO);
      setTimeout(() => {
        conn.close();
      });
    }
  })();

  const err = await assertRejects(() => {
    return connect({ port, reconnect: false });
  });

  assert(
    err instanceof errors.ConnectionError ||
      err instanceof Deno.errors.ConnectionReset,
  );

  listener.close();
  await done;
});

Deno.test("basics - close promise resolves", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port, reconnect: false });
  const results = await Promise.all([nc.closed(), nc.close()]);
  assertEquals(results[0], undefined);
  await ns.stop();
});

Deno.test("basics - inbox prefixes cannot have wildcards", async () => {
  await assertRejects(
    async () => {
      await connect({ inboxPrefix: "_inbox.foo.>" });
    },
    errors.InvalidArgumentError,
    "'prefix' cannot have wildcards",
  );

  assertThrows(
    () => {
      createInbox("_inbox.foo.*");
    },
    errors.InvalidArgumentError,
    "'prefix' cannot have wildcards",
  );
});

Deno.test("basics - msg typed payload", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });

  nc.subscribe("echo", {
    callback: (_err: Error | null, msg: Msg) => {
      msg.respond(msg.data);
    },
  });

  assertEquals((await nc.request("echo", Empty)).string(), "");
  assertEquals((await nc.request("echo", "hello")).string(), "hello");
  assertEquals((await nc.request("echo", "5")).string(), "5");

  await assertRejects(
    async () => {
      const r = await nc.request("echo", Empty);
      r.json<number>();
    },
    Error,
    "Unexpected end of JSON input",
  );

  assertEquals((await nc.request("echo", JSON.stringify(null))).json(), null);
  assertEquals((await nc.request("echo", JSON.stringify(5))).json(), 5);
  assertEquals(
    (await nc.request("echo", JSON.stringify("hello"))).json(),
    "hello",
  );
  assertEquals((await nc.request("echo", JSON.stringify(["hello"]))).json(), [
    "hello",
  ]);
  assertEquals(
    (await nc.request("echo", JSON.stringify({ one: "two" }))).json(),
    { one: "two" },
  );
  assertEquals(
    (await nc.request("echo", JSON.stringify([{ one: "two" }]))).json(),
    [{ one: "two" }],
  );

  await cleanup(ns, nc);
});

Deno.test("basics - ipv4 mapped to ipv6", async () => {
  const ns = await NatsServer.start({ port: 4222 });
  const nc = await connect({ servers: [`::ffff:127.0.0.1`] });
  const nc2 = await connect({ servers: [`[::ffff:127.0.0.1]:${ns.port}`] });
  await cleanup(ns, nc, nc2);
});

Deno.test("basics - data types empty", async () => {
  const { ns, nc } = await setup();
  const subj = nuid.next();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      assertEquals(msg.data.length, 0);
      msg.respond();
    },
  });
  nc.publish(subj);
  nc.publish(subj, Empty);

  let r = await nc.request(subj);
  assertEquals(r.data.length, 0);

  r = await nc.request(subj, Empty);
  assertEquals(r.data.length, 0);

  let iter = await collect(
    await nc.requestMany(subj, undefined, { maxMessages: 1 }),
  );
  assertEquals(iter[0].data.length, 0);

  iter = await collect(
    await nc.requestMany(subj, undefined, { maxMessages: 1 }),
  );
  assertEquals(iter[0].data.length, 0);

  await cleanup(ns, nc);
});

Deno.test("basics - data types string", async () => {
  const { ns, nc } = await setup();
  const subj = nuid.next();
  nc.subscribe(subj, {
    callback: (_err, msg) => {
      const s = msg.string();
      if (s.length > 0) {
        assertEquals(s, "hello");
      }
      msg.respond(s);
    },
  });
  nc.publish(subj, "");
  nc.publish(subj, "hello");

  let r = await nc.request(subj);
  assertEquals(r.string(), "");

  r = await nc.request(subj, "hello");
  assertEquals(r.string(), "hello");

  let iter = await collect(
    await nc.requestMany(subj, "", { maxMessages: 1 }),
  );
  assertEquals(iter[0].string(), "");

  iter = await collect(
    await nc.requestMany(subj, "hello", { maxMessages: 1 }),
  );
  assertEquals(iter[0].string(), "hello");

  await cleanup(ns, nc);
});

Deno.test("basics - json reviver", async () => {
  const { ns, nc } = await setup();
  const subj = nuid.next();

  nc.subscribe(subj, {
    callback: (_err, msg) => {
      msg.respond(JSON.stringify({ date: Date.now(), auth: true }));
    },
  });

  const m = await nc.request(subj);
  const d = m.json<{ date: Date; auth: string }>((key, value) => {
    if (typeof value === "boolean") {
      return value ? "yes" : "no";
    }
    switch (key) {
      case "date":
        return new Date(value);
      default:
        return value;
    }
  });

  assert(d.date instanceof Date);
  assert(typeof d.auth === "string");

  await cleanup(ns, nc);
});

Deno.test("basics - sync subscription", async () => {
  const { ns, nc } = await setup();
  const subj = nuid.next();

  const sub = nc.subscribe(subj);
  const sync = syncIterator(sub);
  nc.publish(subj);

  let m = await sync.next();
  assertExists(m);

  sub.unsubscribe();
  m = await sync.next();
  assertEquals(m, null);

  await cleanup(ns, nc);
});

Deno.test("basics - publish message", async () => {
  const { ns, nc } = await setup();
  const sub = nc.subscribe("q");

  const nis = new MM(nc);
  nis.data = new TextEncoder().encode("not in service");

  (async () => {
    for await (const m of sub) {
      if (m.reply) {
        nis.subject = m.reply;
        nc.publishMessage(nis);
      }
    }
  })().then();

  const r = await nc.request("q");
  assertEquals(r.string(), "not in service");

  await cleanup(ns, nc);
});

Deno.test("basics - respond message", async () => {
  const { ns, nc } = await setup();
  const sub = nc.subscribe("q");

  const nis = new MM(nc);
  nis.data = new TextEncoder().encode("not in service");

  (async () => {
    for await (const m of sub) {
      if (m.reply) {
        nis.reply = m.reply;
        nc.respondMessage(nis);
      }
    }
  })().then();

  const r = await nc.request("q");
  assertEquals(r.string(), "not in service");

  await cleanup(ns, nc);
});

Deno.test("basics - resolve false", async () => {
  const nci = await connect({
    servers: "demo.nats.io",
    resolve: false,
  }) as NatsConnectionImpl;

  const srv = nci.protocol.servers.getCurrentServer();
  assertEquals(srv.resolves, undefined);
  await nci.close();
});

Deno.test("basics - stats", async () => {
  const { ns, nc } = await setup();

  const cid = nc.info?.client_id || -1;
  if (cid === -1) {
    fail("client_id not found");
  }

  async function check(m = ""): Promise<void> {
    await nc.flush();
    const client = nc.stats();
    const { in_msgs, out_msgs, in_bytes, out_bytes } =
      (await ns.connz(cid, "detail")).connections[0];
    const server = { in_msgs, out_msgs, in_bytes, out_bytes };

    console.log(m, client, server);

    assertEquals(client.outBytes, in_bytes);
    assertEquals(client.inBytes, out_bytes);
    assertEquals(client.outMsgs, in_msgs);
    assertEquals(client.inMsgs, out_msgs);
  }

  await check("start");

  // publish
  nc.publish("hello", "world");
  await check("simple publish");

  nc.subscribe("hello", { callback: () => {} });
  nc.publish("hello", "hi");
  await check("subscribe");

  const h = headers();
  h.set("hello", "very long value that we want to add here");
  nc.publish("hello", "hello", { headers: h });
  await check("headers");

  await cleanup(ns, nc);
});

Deno.test("basics - slow", async () => {
  const { ns, nc } = await setup();

  let slow = 0;
  (async () => {
    for await (const m of nc.status()) {
      //@ts-ignore: test
      if (m.type === "slowConsumer") {
        console.log(`sub: ${m.sub.getID()}`);
        slow++;
      }
    }
  })().catch();
  const sub = nc.subscribe("test", { slow: 10 });
  const s = syncIterator(sub);

  // we go over, should have a notification
  for (let i = 0; i < 11; i++) {
    nc.publish("test", "");
  }

  await delay(100);
  assertEquals(sub.getPending(), 11);
  assertEquals(slow, 1);
  slow = 0;

  // send one more, no more notifications until we drop below 10
  nc.publish("test", "");
  await nc.flush(); // 12
  await delay(100);
  assertEquals(sub.getPending(), 12);
  assertEquals(slow, 0);

  await s.next(); // 11
  await s.next(); // 10
  await s.next(); // 9

  nc.publish("test", ""); // 10
  await nc.flush();
  await delay(100);
  assertEquals(sub.getPending(), 10);
  assertEquals(slow, 0);

  // now this will notify
  await s.next(); // 9
  await s.next(); // 8
  await nc.flush();
  await delay(100);
  assertEquals(sub.getPending(), 8);

  await s.next(); // 7
  nc.publish("test", ""); // 8
  await nc.flush();
  await delay(100);
  assertEquals(sub.getPending(), 8);
  assertEquals(slow, 0);

  nc.publish("test", ""); // 9
  nc.publish("test", ""); // 10
  await nc.flush();
  await delay(100);

  assertEquals(sub.getPending(), 10);
  assertEquals(slow, 0);

  nc.publish("test", ""); // 11
  await nc.flush();
  await delay(100);
  assertEquals(sub.getPending(), 11);
  assertEquals(slow, 1);

  await cleanup(ns, nc);
});

Deno.test("basics - msg sids", async () => {
  const { ns, nc } = await setup();
  const lock = Lock(2);

  let first: Msg;
  let second: Msg;
  const sub = nc.subscribe("test", {
    callback: (_, msg) => {
      first = msg;
      lock.unlock();
    },
  });

  const sub2 = nc.subscribe(">", {
    callback: (_, msg) => {
      second = msg;
      lock.unlock();
    },
  });

  nc.publish("test", "hello", { reply: "foo" });

  await lock;
  assertEquals(first!.sid, sub.getID());
  assertEquals(
    (first! as MsgImpl).size(),
    "hello".length + "test".length + "foo".length,
  );
  assertEquals(second!.sid, sub2.getID());

  await cleanup(ns, nc);
});

class MM implements Msg {
  data!: Uint8Array;
  sid: number;
  subject!: string;
  reply?: string;
  headers?: MsgHdrs;
  publisher: Publisher;

  constructor(p: Publisher) {
    this.publisher = p;
    this.sid = -1;
  }

  json<T>(): T {
    throw new Error("not implemented");
  }

  respond(payload?: Payload, opts?: PublishOptions): boolean {
    if (!this.reply) {
      return false;
    }
    payload = payload || Empty;
    this.publisher.publish(this.reply, payload, opts);
    return true;
  }

  respondMessage(m: Msg): boolean {
    return this.respond(m.data, { headers: m.headers, reply: m.reply });
  }

  string(): string {
    return "";
  }
}

Deno.test("basics - internal close listener", async () => {
  const ns = await NatsServer.start();
  const port = ns.port;

  // nothing bad should happen if none registered
  let nc = await connect({ port }) as NatsConnectionImpl;
  await nc.close();

  function makeListener(d: Deferred<unknown>): ConnectionClosedListener {
    return {
      connectionClosedCallback: () => {
        d.resolve();
      },
    };
  }

  // can add and remove
  nc = await connect({ port }) as NatsConnectionImpl;
  let done = deferred();
  let listener = makeListener(done);

  (nc as NatsConnectionImpl).addCloseListener(listener);
  // @ts-ignore: internal
  assertEquals((nc as NatsConnectionImpl).closeListeners.listeners.length, 1);
  (nc as NatsConnectionImpl).removeCloseListener(listener);
  // @ts-ignore: internal
  assertEquals((nc as NatsConnectionImpl).closeListeners.listeners.length, 0);
  await nc.close();
  done.resolve();
  await done;

  // closed called
  nc = await connect({ port }) as NatsConnectionImpl;
  done = deferred();
  listener = makeListener(done);
  (nc as NatsConnectionImpl).addCloseListener(listener);
  await nc.close();
  await done;
  // @ts-ignore: internal
  assertEquals((nc as NatsConnectionImpl).closeListeners.listeners.length, 0);

  await ns.stop();
});

Deno.test("basics - publish tracing", async () => {
  const { ns, nc } = await setup();
  const sub = nc.subscribe("foo", { callback: () => {} });

  const traces = nc.subscribe("traces", {
    callback: () => {},
    max: 2,
  });
  nc.flush();

  nc.publish("foo", Empty, { traceDestination: "traces" });
  nc.publish("foo", Empty, { traceDestination: "traces", traceOnly: true });

  await traces.closed;
  assertEquals(sub.getReceived(), 1);
  assertEquals(traces.getReceived(), 2);

  await cleanup(ns, nc);
});

Deno.test("basics - request tracing", async () => {
  const { ns, nc } = await setup();
  const sub = nc.subscribe("foo", {
    callback: (_, m) => {
      m.respond();
    },
  });

  const traces = nc.subscribe("traces", {
    callback: () => {},
    max: 2,
  });
  nc.flush();

  await nc.request("foo", Empty, {
    timeout: 2_000,
    traceDestination: "traces",
  });
  await assertRejects(() => {
    return nc.request("foo", Empty, {
      timeout: 2_000,
      traceDestination: "traces",
      traceOnly: true,
    });
  });

  await traces.closed;
  assertEquals(sub.getReceived(), 1);
  assertEquals(traces.getReceived(), 2);

  await cleanup(ns, nc);
});

Deno.test("basics - close status", async () => {
  const { ns, nc } = await setup();
  setTimeout(() => {
    nc.close();
  }, 500);
  const d = deferred();

  for await (const s of nc.status()) {
    if (s.type === "close") {
      d.resolve();
    }
  }
  await d;
  await cleanup(ns, nc);
});
