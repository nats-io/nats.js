/*
 * Copyright 2023-2024 The NATS Authors
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

import { initStream } from "./jstest_util.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type ConsumerNotification,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
} from "../src/mod.ts";
import type { ConsumerMessages, JsMsg } from "../src/mod.ts";
import { cleanup, jetstreamServerConf, notCompatible, setup } from "nst";
import {
  deadline,
  deferred,
  delay,
  Empty,
  headers,
  nanos,
} from "@nats-io/nats-core";
import type { NatsConnection } from "@nats-io/nats-core";
import type {
  PullConsumerImpl,
  PullConsumerMessagesImpl,
} from "../src/consumer.ts";
import { delayUntilAssetNotFound } from "./util.ts";
import { flakyTest } from "nst";

Deno.test("ordered consumers - get", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);

  await assertRejects(
    async () => {
      await js.consumers.get("a");
    },
    Error,
    "stream not found",
  );

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test"] });
  await js.publish("test");

  const oc = await js.consumers.get("test") as PullConsumerImpl;
  assertExists(oc);

  const ci = await oc.info();
  assertEquals(ci.name, `${oc.opts.name_prefix}_${oc.serial}`);
  assertEquals(ci.num_pending, 1);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - fetch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });
  await js.publish("test.a");
  await js.publish("test.b");
  await js.publish("test.c");

  const oc = await js.consumers.get("test") as PullConsumerImpl;
  assertExists(oc);

  let iter = await oc.fetch({ max_messages: 1 });
  for await (const m of iter) {
    assertEquals(m.subject, "test.a");
    assertEquals(m.seq, 1);
  }

  iter = await oc.fetch({ max_messages: 1 });
  for await (const m of iter) {
    assertEquals(m.subject, "test.b");
    assertEquals(m.seq, 2);
  }

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - consume reset", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });
  await js.publish("test.a");
  await js.publish("test.b");
  await js.publish("test.c");

  const oc = await js.consumers.get("test") as PullConsumerImpl;
  assertExists(oc);

  const seen: number[] = new Array(3).fill(0);
  const done = deferred();

  const callback = (r: JsMsg) => {
    const idx = r.seq - 1;
    seen[idx]++;
    // mess with the internals so we see these again
    if (seen[idx] === 1) {
      const state = oc.orderedConsumerState!;
      const cursor = state.cursor;
      cursor.deliver_seq--;
      cursor.stream_seq--;
    }
    if (r.info.pending === 0) {
      iter.stop();
      done.resolve();
    }
  };

  const iter = await oc.consume({
    max_messages: 1,
    callback,
  });
  await done;

  assertEquals(seen, [2, 2, 1]);
  assertEquals(oc.serial, 3);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - consume", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });
  await js.publish("test.a");
  await js.publish("test.b");
  await js.publish("test.c");

  const oc = await js.consumers.get("test") as PullConsumerImpl;
  assertExists(oc);

  const iter = await oc.consume({ max_messages: 1 });
  for await (const m of iter) {
    if (m.info.pending === 0) {
      break;
    }
  }

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - filters consume", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await js.publish("test.a");
  await js.publish("test.b");
  await js.publish("test.c");

  const oc = await js.consumers.get("test", { filter_subjects: ["test.b"] });
  assertExists(oc);

  const iter = await oc.consume();
  for await (const m of iter) {
    assertEquals("test.b", m.subject);
    if (m.info.pending === 0) {
      break;
    }
  }

  assertEquals(iter.getProcessed(), 1);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - filters fetch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await js.publish("test.a");
  await js.publish("test.b");
  await js.publish("test.c");

  const oc = await js.consumers.get("test", { filter_subjects: ["test.b"] });
  assertExists(oc);

  const iter = await oc.fetch({ expires: 1000 });
  for await (const m of iter) {
    assertEquals("test.b", m.subject);
  }
  assertEquals(iter.getProcessed(), 1);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - fetch reject consumer type change or concurrency", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  const oc = await js.consumers.get("test");
  const iter = await oc.fetch();
  (async () => {
    for await (const _r of iter) {
      // nothing
    }
  })().then();

  await assertRejects(
    () => {
      return oc.fetch();
    },
    Error,
    "ordered consumer doesn't support concurrent fetch",
  );

  await assertRejects(
    () => {
      return oc.consume();
    },
    Error,
    "ordered consumer initialized as fetch",
  );

  await iter.stop();

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - consume reject consumer type change or concurrency", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  const oc = await js.consumers.get("test");
  const iter = await oc.consume({ expires: 3000 });
  (async () => {
    for await (const _r of iter) {
      // nothing
    }
  })().then();

  await assertRejects(
    async () => {
      await oc.consume();
    },
    Error,
    "ordered consumer doesn't support concurrent consume",
  );

  await assertRejects(
    async () => {
      await oc.fetch();
    },
    Error,
    "ordered consumer already initialized as consume",
  );

  await iter.stop();

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - last per subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await Promise.all([
    js.publish("test.a"),
    js.publish("test.a"),
  ]);

  let oc = await js.consumers.get("test", {
    deliver_policy: DeliverPolicy.LastPerSubject,
  });
  let iter = await oc.fetch({ max_messages: 1 });
  await (async () => {
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 2);
    }
  })();

  oc = await js.consumers.get("test", {
    deliver_policy: DeliverPolicy.LastPerSubject,
  });
  iter = await oc.consume({ max_messages: 1 });
  await (async () => {
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 2);
      break;
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - start sequence", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await Promise.all([
    js.publish("test.a"),
    js.publish("test.b"),
  ]);

  let oc = await js.consumers.get("test", {
    opt_start_seq: 2,
  });

  let iter = await oc.fetch({ max_messages: 1 });
  await (async () => {
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 2);
    }
  })();

  oc = await js.consumers.get("test", {
    opt_start_seq: 2,
  });
  iter = await oc.consume({ max_messages: 1 });
  await (async () => {
    for await (const r of iter) {
      assertEquals(r.info.streamSequence, 2);
      assertEquals(r.subject, "test.b");
      break;
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - last", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await Promise.all([
    js.publish("test.a"),
    js.publish("test.b"),
  ]);

  let oc = await js.consumers.get("test", {
    deliver_policy: DeliverPolicy.Last,
  });

  let iter = await oc.fetch({ max_messages: 1 });
  await (async () => {
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 2);
      assertEquals(m.subject, "test.b");
    }
  })();

  oc = await js.consumers.get("test", {
    deliver_policy: DeliverPolicy.Last,
  });
  iter = await oc.consume({ max_messages: 1 });
  await (async () => {
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 2);
      assertEquals(m.subject, "test.b");
      break;
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - new", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await Promise.all([
    js.publish("test.a"),
    js.publish("test.b"),
  ]);

  let oc = await js.consumers.get("test", {
    deliver_policy: DeliverPolicy.New,
  });

  let iter = await oc.fetch({ max_messages: 1 });
  await (async () => {
    await js.publish("test.c");
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 3);
      assertEquals(m.subject, "test.c");
    }
  })();

  oc = await js.consumers.get("test", {
    deliver_policy: DeliverPolicy.New,
  });
  iter = await oc.consume({ max_messages: 1 });
  await (async () => {
    await js.publish("test.d");
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 4);
      assertEquals(m.subject, "test.d");
      break;
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - start time", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await Promise.all([
    js.publish("test.a"),
    js.publish("test.b"),
  ]);

  await delay(500);
  const date = new Date().toISOString();

  let oc = await js.consumers.get("test", {
    deliver_policy: DeliverPolicy.StartTime,
    opt_start_time: date,
  });

  await js.publish("test.c");

  let iter = await oc.fetch({ max_messages: 1 });
  await (async () => {
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 3);
      assertEquals(m.subject, "test.c");
    }
  })();

  oc = await js.consumers.get("test", {
    deliver_policy: DeliverPolicy.StartTime,
    opt_start_time: date,
  });
  iter = await oc.consume({ max_messages: 1 });
  await (async () => {
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 3);
      assertEquals(m.subject, "test.c");
      break;
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - start time reset", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const js = jetstream(nc);
  await Promise.all([
    js.publish("test.a"),
    js.publish("test.b"),
  ]);

  await delay(500);
  const date = new Date().toISOString();

  const oc = await js.consumers.get("test", {
    deliver_policy: DeliverPolicy.StartTime,
    opt_start_time: date,
  }) as PullConsumerImpl;

  await js.publish("test.c");

  const iter = await oc.fetch({ max_messages: 1 }) as PullConsumerMessagesImpl;
  await (async () => {
    for await (const m of iter) {
      assertEquals(m.info.streamSequence, 3);
      assertEquals(m.subject, "test.c");

      // now that we are here
      const opts = oc.getConsumerOpts();
      assertEquals(opts.opt_start_seq, 4);
      assertEquals(opts.deliver_policy, DeliverPolicy.StartSequence);
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - next", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test"] });
  const js = jetstream(nc);

  const c = await js.consumers.get("test");
  let m = await c.next({ expires: 1000 });
  assertEquals(m, null);

  await Promise.all([
    js.publish("test", "hello"),
    js.publish("test", "goodbye"),
  ]);
  await nc.flush();

  m = await c.next({ expires: 1000 });
  assertEquals(m?.seq, 1);

  m = await c.next({ expires: 1000 });
  assertEquals(m?.seq, 2);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - sub leaks next()", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream } = await initStream(nc);

  //@ts-ignore: test
  assertEquals(nc.protocol.subscriptions.size(), 1);
  const js = jetstream(nc);
  const c = await js.consumers.get(stream);
  await c.next({ expires: 1000 });
  //@ts-ignore: test
  assertEquals(nc.protocol.subscriptions.size(), 1);
  await cleanup(ns, nc);
});

Deno.test("ordered consumers - sub leaks fetch()", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream } = await initStream(nc);

  //@ts-ignore: test
  assertEquals(nc.protocol.subscriptions.size(), 1);
  const js = jetstream(nc);
  const c = await js.consumers.get(stream);
  const iter = await c.fetch({ expires: 1000 });
  const done = (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })().then();
  await done;
  //@ts-ignore: test
  assertEquals(nc.protocol.subscriptions.size(), 1);
  await cleanup(ns, nc);
});

Deno.test("ordered consumers - sub leaks consume()", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream } = await initStream(nc);

  //@ts-ignore: test
  assertEquals(nc.protocol.subscriptions.size(), 1);
  const js = jetstream(nc);
  const c = await js.consumers.get(stream);
  const iter = await c.consume({ expires: 30000 });
  const done = (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })().then();
  setTimeout(() => {
    iter.close();
  }, 1000);

  await done;
  //@ts-ignore: test
  assertEquals(nc.protocol.subscriptions.size(), 1);
  await cleanup(ns, nc);
});

Deno.test("ordered consumers - consume drain", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream } = await initStream(nc);

  const js = jetstream(nc);
  const c = await js.consumers.get(stream);
  const iter = await c.consume({ expires: 30000 });
  setTimeout(() => {
    nc.drain();
  }, 100);
  const done = (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })().then();

  await deadline(done, 1000);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - headers only", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const oc = await js.consumers.get("test", { headers_only: true });
  const ci = await oc.info();
  assertExists(ci);
  assertEquals(ci.config.headers_only, true);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - max deliver", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const oc = await js.consumers.get("test");
  const ci = await oc.info();
  assertExists(ci);
  assertEquals(ci.config.max_deliver, 1);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - mem", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "test", subjects: ["test.*"] });

  const oc = await js.consumers.get("test");
  const ci = await oc.info();
  assertExists(ci);
  assertEquals(ci.config.mem_storage, true);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - inboxPrefix is respected", async () => {
  const { ns, nc } = await setup(jetstreamServerConf(), {
    inboxPrefix: "x",
  });
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "messages", subjects: ["hello"] });

  const js = jetstream(nc);

  const consumer = await js.consumers.get("messages");
  const iter = await consumer.consume() as PullConsumerMessagesImpl;
  const done = (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })().catch();
  assertStringIncludes(iter.sub.getSubject(), "x.");
  iter.stop();
  await done;
  await cleanup(ns, nc);
});

Deno.test("ordered consumers - fetch deleted consumer", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  const js = jetstream(nc);
  const c = await js.consumers.get("A");

  const iter = await c.fetch({
    expires: 3000,
  });

  const exited = assertRejects(
    async () => {
      for await (const _ of iter) {
        // nothing
      }
    },
    Error,
    "consumer deleted",
  );

  await delay(1000);
  await c.delete();

  await exited;
  await cleanup(ns, nc);
});

Deno.test("ordered consumers - next deleted consumer", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["hello"] });

  const js = jetstream(nc);
  const c = await js.consumers.get("A");

  const exited = assertRejects(
    () => {
      return c.next({ expires: 4000 });
    },
    Error,
    "consumer deleted",
  );
  await delay(1000);
  await c.delete();

  await exited;

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - consume stream not found request abort", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  const js = jetstream(nc);
  const c = await js.consumers.get("A");
  await jsm.streams.delete("A");

  const iter = await c.consume({
    expires: 3000,
    abort_on_missing_resource: true,
  });

  await assertRejects(
    async () => {
      for await (const _ of iter) {
        // ignore
      }
    },
    Error,
    "stream not found",
  );

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - consume consumer deleted request abort", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  const js = jetstream(nc);
  const c = await js.consumers.get("A");
  const iter = await c.consume({
    expires: 3000,
    abort_on_missing_resource: true,
  });

  const done = assertRejects(
    async () => {
      for await (const _ of iter) {
        // nothing
      }
    },
    Error,
    "consumer deleted",
  );

  await delay(1000);
  await c.delete();
  await done;

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - bind is rejected", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  const js = jetstream(nc);
  const c = await js.consumers.get("A");

  await assertRejects(
    () => {
      return c.next({ bind: true });
    },
    Error,
    "'bind' is not supported",
  );

  await assertRejects(
    () => {
      return c.fetch({ bind: true });
    },
    Error,
    "'bind' is not supported",
  );

  await assertRejects(
    () => {
      return c.consume({ bind: true });
    },
    Error,
    "'bind' is not supported",
  );

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - name prefix", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  const js = jetstream(nc);
  const c = await js.consumers.get("A", { name_prefix: "hello" });
  const ci = await c.info(true);
  assert(ci.name.startsWith("hello"));

  await assertRejects(
    () => {
      return js.consumers.get("A", { name_prefix: "" });
    },
    Error,
    "name_prefix name required",
  );

  await assertRejects(
    () => {
      return js.consumers.get("A", { name_prefix: "one.two" });
    },
    Error,
    "name_prefix name ('one.two') cannot contain '.'",
  );

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - fetch reset", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  await js.publish("a", JSON.stringify(1));

  const c = await js.consumers.get("A") as PullConsumerImpl;

  let recreates = 0;
  function countResets(iter: ConsumerMessages): Promise<void> {
    return (async () => {
      for await (const s of iter.status()) {
        if (s.type === "ordered_consumer_recreated") {
          recreates++;
        }
      }
    })();
  }

  // after the first message others will get published
  let iter = await c.fetch({ max_messages: 10, expires: 3_000 });
  const first = countResets(iter);
  const sequences = [];
  for await (const m of iter) {
    sequences.push(m.json());
  }

  const buf = [];
  for (let i = 2; i < 12; i++) {
    buf.push(js.publish("a", JSON.stringify(i)));
  }
  await Promise.all(buf);

  iter = await c.fetch({ max_messages: 10, expires: 2_000 });
  const second = countResets(iter);

  const done = (async () => {
    for await (const m of iter) {
      sequences.push(m.json());
    }
  })().catch();

  await Promise.all([first, second, done]);
  assertEquals(c.serial, 1);
  assertEquals(recreates, 0);
  assertEquals(sequences, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  await cleanup(ns, nc);
});

Deno.test("ordered consumers - consume reset", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  await js.publish("a", JSON.stringify(1));

  let recreates = 0;
  function countRecreates(iter: ConsumerMessages): Promise<void> {
    return (async () => {
      for await (const s of iter.status()) {
        if (s.type === "ordered_consumer_recreated") {
          recreates++;
        }
      }
    })();
  }

  const c = await js.consumers.get("A") as PullConsumerImpl;

  // after the first message others will get published
  const iter = await c.consume({ max_messages: 11, idle_heartbeat: 1_000 });
  countRecreates(iter).catch();
  const sequences = [];
  for await (const m of iter) {
    sequences.push(m.json());
    // mess with the internal state to cause a reset
    if (m.seq === 1) {
      c.orderedConsumerState!.cursor.deliver_seq = 3;
      const buf = [];
      for (let i = 2; i < 20; i++) {
        buf.push(js.publish("a", JSON.stringify(i)));
      }
      await Promise.all(buf);
    }
    if (m.seq === 11) {
      break;
    }
  }

  assertEquals(c.serial, 2);
  assertEquals(recreates, 1);
  assertEquals(sequences, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - consume ignores old consumer while recreating", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  for (let i = 1; i <= 5; i++) {
    await js.publish("a", JSON.stringify(i));
  }

  const c = await js.consumers.get("A") as PullConsumerImpl;
  const old = c._info;
  const sequences: number[] = [];
  let last = deferred();
  const iter = await c.consume({
    max_messages: 10,
    callback: (m) => {
      sequences.push(m.json());
      if (m.seq === 5 || m.seq === 6) {
        last.resolve();
      }
    },
  }) as PullConsumerMessagesImpl;
  const pulls: number[] = [];
  (async () => {
    for await (const s of iter.status()) {
      if (s.type === "next") {
        pulls.push(s.options.batch);
      }
    }
  })().then();
  await last;

  // the replacement consumer cannot be created for now
  const api = c.api;
  const add = api.add.bind(api);
  const del = api.delete.bind(api);
  let unavailable = true;
  api.add = (stream, cfg) => {
    return unavailable
      ? Promise.reject(new Error("unavailable"))
      : add(stream, cfg);
  };
  api.delete = () => Promise.resolve(true);
  iter.reset();

  // the old consumer is still there, but it starts over (like a memory
  // consumer recovered after a server restart)
  await del("A", old.name);
  await add("A", old.config);

  // a reconnect while the reset is pending: the client must not pull the
  // old consumer into the new inbox, or its deliveries start over as
  // duplicates
  await iter.resetPending();
  await delay(1_000);
  assertEquals(sequences, [1, 2, 3, 4, 5]);

  last = deferred();
  pulls.length = 0;
  unavailable = false;
  await js.publish("a", JSON.stringify(6));
  await deadline(last, 10_000);
  assertEquals(sequences, [1, 2, 3, 4, 5, 6]);
  // the new consumer is asked for a full batch
  assertEquals(pulls[0], 10);
  iter.stop();

  await cleanup(ns, nc);
});

// injects a fake idle heartbeat on the consume's current inbox
function fakeHeartbeat(
  nc: NatsConnection,
  iter: PullConsumerMessagesImpl,
  lastConsumer: number,
) {
  const h = headers(100, "Idle Heartbeat");
  h.set("Nats-Last-Consumer", `${lastConsumer}`);
  h.set("Nats-Last-Stream", `${lastConsumer}`);
  nc.publish(iter.inbox, Empty, { headers: h });
}

Deno.test("ordered consumers - consume recovers from heartbeat sequence mismatch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  const N = 100;
  for (let i = 0; i < N; i++) {
    await js.publish("a");
  }

  const c = await js.consumers.get("A") as PullConsumerImpl;
  const sequences: number[] = [];
  const done = deferred();
  const iter = await c.consume({
    max_messages: 10,
    callback: (m) => {
      sequences.push(m.seq);
      // while the server is still delivering
      if (m.seq === 5) {
        fakeHeartbeat(nc, iter, 999_999);
      }
      if (m.seq === N) {
        done.resolve();
      }
    },
  }) as PullConsumerMessagesImpl;

  await deadline(done, 10_000);
  assertEquals(sequences, Array.from({ length: N }, (_, i) => i + 1));
  // the ordered consumer was reset
  assertEquals(c.serial, 2);
  iter.stop();

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - consume ignores matching heartbeats", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  for (let i = 0; i < 5; i++) {
    await js.publish("a");
  }

  const c = await js.consumers.get("A") as PullConsumerImpl;
  const sequences: number[] = [];
  let last = deferred();
  let want = 5;
  const iter = await c.consume({
    callback: (m) => {
      sequences.push(m.seq);
      if (m.seq === want) {
        last.resolve();
      }
    },
  }) as PullConsumerMessagesImpl;
  await deadline(last, 5_000);

  fakeHeartbeat(nc, iter, 5);
  await delay(500);

  last = deferred();
  want = 6;
  await js.publish("a");
  await deadline(last, 5_000);
  assertEquals(sequences, [1, 2, 3, 4, 5, 6]);
  // no reset
  assertEquals(c.serial, 1);
  iter.stop();

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - next reset", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  await js.publish("a", JSON.stringify(1));
  await js.publish("a", JSON.stringify(2));

  const c = await js.consumers.get("A") as PullConsumerImpl;

  // get the first
  let m = await c.next({ expires: 1000 });
  assertExists(m);
  assertEquals(m.json(), 1);

  // force a reset
  c.orderedConsumerState!.cursor.deliver_seq = 100;

  m = await c.next({ expires: 1000 });
  assertExists(m);
  assertEquals(m.json(), 2);
  assertEquals(c.serial, 2);

  // a fetch that stops while its reset can't recreate the consumer
  const add = c.api.add.bind(c.api);
  c.api.add = () => Promise.reject(new Error("unavailable"));
  await js.publish("a", JSON.stringify(3));
  c.orderedConsumerState!.cursor.deliver_seq = 100;
  const iter = await c.fetch({ max_messages: 1, expires: 1000 });
  const done = (async () => {
    for await (const _ of iter) {
      // reset - nothing is yielded
    }
  })();
  await delay(500);
  await iter.close();
  await done;
  c.api.add = add;

  // the next fetch recreates it
  m = await deadline(c.next({ expires: 1000 }), 5_000);
  assertExists(m);
  assertEquals(m.json(), 3);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - fetch rejects while another fetch resets", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  await js.publish("a", JSON.stringify(1));
  await js.publish("a", JSON.stringify(2));

  const c = await js.consumers.get("A") as PullConsumerImpl;
  let m = await c.next({ expires: 1000 });
  assertExists(m);
  assertEquals(m.json(), 1);

  // the first fetch recreates the consumer, the second is concurrent
  c.orderedConsumerState!.needsReset = true;
  const first = c.fetch({ max_messages: 1, expires: 1000 });
  await assertRejects(
    () => c.fetch({ max_messages: 1, expires: 1000 }),
    Error,
    "ordered consumer doesn't support concurrent fetch",
  );
  // next is a fetch
  await assertRejects(
    () => c.next({ expires: 1000 }),
    Error,
    "ordered consumer doesn't support concurrent fetch",
  );
  assertEquals(c.serial, 2);

  // the first fetch is unaffected
  const iter = await first;
  m = null;
  for await (const jm of iter) {
    m = jm;
  }
  assertExists(m);
  assertEquals(m.json(), 2);
  assertEquals(c._info.name, c.name);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - reset preserves inactive_threshold", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  await js.publish("a", JSON.stringify(1));
  await js.publish("a", JSON.stringify(2));
  await js.publish("a", JSON.stringify(3));

  const c = await js.consumers.get("A", {
    inactive_threshold: 10_000,
  }) as PullConsumerImpl;
  let ci = await c.info();
  assertEquals(ci.config.inactive_threshold, nanos(10_000));

  let m = await c.next({ expires: 1000 });
  assertEquals(m?.json(), 1);

  // force a reset
  c.orderedConsumerState!.cursor.deliver_seq = 100;
  m = await c.next({ expires: 1000 });
  assertEquals(m?.json(), 2);
  assertEquals(c.serial, 2);
  ci = await jsm.consumers.info("A", c.name);
  assertEquals(ci.name, `${c.orderedConsumerState!.namePrefix}_2`);
  assertEquals(ci.config.inactive_threshold, nanos(10_000));

  // force another reset, value must persist across resets
  c.orderedConsumerState!.cursor.deliver_seq = 100;
  m = await c.next({ expires: 1000 });
  assertEquals(m?.json(), 3);
  assertEquals(c.serial, 3);
  ci = await jsm.consumers.info("A", c.name);
  assertEquals(ci.name, `${c.orderedConsumerState!.namePrefix}_3`);
  assertEquals(ci.config.inactive_threshold, nanos(10_000));

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - reset keeps default inactive_threshold", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  await js.publish("a", JSON.stringify(1));
  await js.publish("a", JSON.stringify(2));

  const c = await js.consumers.get("A") as PullConsumerImpl;
  let m = await c.next({ expires: 1000 });
  assertEquals(m?.json(), 1);

  // force a reset
  c.orderedConsumerState!.cursor.deliver_seq = 100;
  m = await c.next({ expires: 1000 });
  assertEquals(m?.json(), 2);
  assertEquals(c.serial, 2);
  const ci = await jsm.consumers.info("A", c.name);
  assertEquals(ci.name, `${c.orderedConsumerState!.namePrefix}_2`);
  assertEquals(ci.config.inactive_threshold, nanos(5 * 60 * 1000));

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - no reset on next", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);

  await js.publish("a", JSON.stringify(1));
  await js.publish("a", JSON.stringify(2));
  await nc.flush();

  const c = await js.consumers.get("A") as PullConsumerImpl;
  let m = await c.next();
  assertExists(m);

  m = await c.next();
  assertExists(m);

  assertEquals(c.serial, 1);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - initial creation fails, consumer fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jsm.jetstream();

  const c = await js.consumers.get("A");
  await jsm.streams.delete("A");

  const iter = await c.consume({
    abort_on_missing_resource: true,
    idle_heartbeat: 1000,
  });

  await assertRejects(
    async () => {
      for await (const _ of iter) {
        // nothing
      }
    },
    Error,
    "stream not found",
  );

  await cleanup(ns, nc);
});

Deno.test(
  "ordered consumers - stale reference recovers",
  async () => {
    const { ns, nc } = await setup(jetstreamServerConf());
    const jsm = await jetstreamManager(nc);

    await jsm.streams.add({ name: "A", subjects: ["a"] });
    const js = jsm.jetstream();
    await Promise.all([
      js.publish("a", JSON.stringify(1)),
      js.publish("a", JSON.stringify(2)),
    ]);

    const c = await js.consumers.get("A") as PullConsumerImpl;
    let m = await c.next({ expires: 1000 });
    assertExists(m);
    assertEquals(m.json<number>(), 1);
    assert(await c.delete());

    // continue until the server says the consumer doesn't exist
    await delayUntilAssetNotFound(c);

    // so should get CnF once
    await assertRejects(
      () => {
        return c.next({ expires: 1000 });
      },
      Error,
      "no responders",
    );

    // but now it will be created in line
    m = await c.next({ expires: 1000 });
    assertExists(m);
    assertEquals(m.json<number>(), 2);

    await cleanup(ns, nc);
  },
);

Deno.test(
  "ordered consumers - consume stale reference recovers",
  flakyTest(async () => {
    const { ns, nc } = await setup(jetstreamServerConf());
    const jsm = await jetstreamManager(nc);
    await jsm.streams.add({ name: "A", subjects: ["a"] });
    const js = jetstream(nc);
    await js.publish("a", JSON.stringify(1));

    const c = await js.consumers.get("A") as PullConsumerImpl;
    assert(await c.delete());
    // continue until the server says the consumer doesn't exist
    await delayUntilAssetNotFound(c);

    const iter = await c.consume({ idle_heartbeat: 1_000, expires: 30_000 });

    let recreates = 0;
    function countRecreates(iter: ConsumerMessages): Promise<void> {
      return (async () => {
        for await (const s of iter.status()) {
          if (s.type === "ordered_consumer_recreated") {
            recreates++;
          }
        }
      })();
    }

    const done = countRecreates(iter);

    await (async () => {
      for await (const m of iter) {
        assertEquals(m.json<number>(), 1);
        break;
      }
    })();

    await done;

    assertEquals(c.serial, 2);

    await cleanup(ns, nc);
  }),
);

Deno.test("ordered consumer - deliver all policy", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  const js = jetstream(nc);
  await js.consumers.get("A", { deliver_policy: DeliverPolicy.All });

  await cleanup(ns, nc);
});

Deno.test("ordered - consume stream not found and no responders", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf(),
  );

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "messages", subjects: ["m"] });

  const c = await jsm.jetstream().consumers.get("messages");
  await jsm.streams.delete("messages");
  const iter = await c.consume({ expires: 5_000 });

  const hbmP = deferred();

  const buf: ConsumerNotification[] = [];
  (async () => {
    for await (const s of await iter.status()) {
      console.log(s);
      buf.push(s);
      if (s.type === "heartbeats_missed" && s.count === 3) {
        hbmP.resolve();
      }
    }
  })().then();

  const nextP = deferred();
  (async () => {
    for await (const _ of iter) {
      nextP.resolve();
    }
  })().then();

  await hbmP;
  const snfs = buf.filter((s) => s.type === "stream_not_found").length;
  const nrs = buf.filter((s) => s.type === "no_responders").length;

  assert(snfs > 0);
  assert(nrs > 0);

  await jsm.streams.add({ name: "messages", subjects: ["m"] });
  await jsm.jetstream().publish("m");
  await nextP;

  await cleanup(ns, nc);
});

Deno.test("ordered - fetch stream not found and no responders", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf(),
  );

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "messages", subjects: ["m"] });

  const c = await jsm.jetstream().consumers.get("messages");
  await jsm.streams.delete("messages");

  await assertRejects(
    async () => {
      const iter = await c.fetch({ expires: 5_000 });
      for await (const _ of iter) {
        // will fail
      }
    },
    Error,
    "no responders",
  );

  await jsm.streams.add({ name: "messages", subjects: ["m"] });
  await jsm.jetstream().publish("m");

  const mP = deferred();
  (async () => {
    const iter = await c.fetch({ expires: 5_000 });
    for await (const _ of iter) {
      mP.resolve();
      break;
    }
  })().then();

  await mP;

  await cleanup(ns, nc);
});

Deno.test("ordered - next stream not found and no responders", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf(),
  );

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "messages", subjects: ["m"] });

  const c = await jsm.jetstream().consumers.get("messages");
  await jsm.streams.delete("messages");

  await assertRejects(
    () => {
      return c.next();
    },
    Error,
    "no responders",
  );

  await jsm.streams.add({ name: "messages", subjects: ["m"] });
  await jsm.jetstream().publish("m");

  const oc = c as PullConsumerImpl;
  let m = await c.next();
  assertExists(m);
  assertEquals(oc.serial, 2);

  // recreated once, not again on every call
  await jsm.jetstream().publish("m");
  m = await c.next();
  assertEquals(m?.seq, 2);
  assertEquals(oc.serial, 2);

  // the recreated consumer's deliveries start over
  oc.orderedConsumerState!.needsReset = true;
  await jsm.jetstream().publish("m");
  m = await c.next();
  assertEquals(m?.seq, 3);
  assertEquals(oc.serial, 3);

  await cleanup(ns, nc);
});
