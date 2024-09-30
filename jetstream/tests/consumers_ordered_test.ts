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
} from "jsr:@std/assert";
import {
  ConsumerEvents,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
} from "../src/mod.ts";
import type { ConsumerMessages } from "../src/mod.ts";
import {
  _setup,
  cleanup,
  connect,
  jetstreamServerConf,
  notCompatible,
} from "test_helpers";
import { deadline, delay } from "@nats-io/nats-core";
import type {
  PullConsumerImpl,
  PullConsumerMessagesImpl,
} from "../src/consumer.ts";

Deno.test("ordered consumers - get", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
//
// Deno.test("ordered consumers - fetch", async () => {
//   const { ns, nc } = await _setup(connect, jetstreamServerConf());
//   const js = jetstream(nc);
//
//   const jsm = await jetstreamManager(nc);
//   await jsm.streams.add({ name: "test", subjects: ["test.*"] });
//   await js.publish("test.a");
//   await js.publish("test.b");
//   await js.publish("test.c");
//
//   const oc = await js.consumers.get("test") as PullConsumerImpl;
//   assertExists(oc);
//
//   let iter = await oc.fetch({ max_messages: 1 });
//   for await (const m of iter) {
//     assertEquals(m.subject, "test.a");
//     assertEquals(m.seq, 1);
//   }
//
//   iter = await oc.fetch({ max_messages: 1 });
//   for await (const m of iter) {
//     assertEquals(m.subject, "test.b");
//     assertEquals(m.seq, 2);
//   }
//
//   await cleanup(ns, nc);
// });
//
// Deno.test("ordered consumers - consume reset", async () => {
//   const { ns, nc } = await _setup(connect, jetstreamServerConf());
//   const js = jetstream(nc);
//
//   const jsm = await jetstreamManager(nc);
//   await jsm.streams.add({ name: "test", subjects: ["test.*"] });
//   await js.publish("test.a");
//   await js.publish("test.b");
//   await js.publish("test.c");
//
//   const oc = await js.consumers.get("test") as PullConsumerImpl;
//   assertExists(oc);
//
//   const seen: number[] = new Array(3).fill(0);
//   const done = deferred();
//
//   const callback = (r: JsMsg) => {
//     const idx = r.seq - 1;
//     seen[idx]++;
//     // mess with the internals so we see these again
//     if (seen[idx] === 1) {
//       oc..cursor.deliver_seq--;
//       oc.cursor.stream_seq--;
//     }
//     if (r.info.pending === 0) {
//       iter.stop();
//       done.resolve();
//     }
//   };
//
//   const iter = await oc.consume({
//     max_messages: 1,
//     callback,
//   });
//   await done;
//
//   assertEquals(seen, [2, 2, 1]);
//   assertEquals(oc.serial, 3);
//
//   await cleanup(ns, nc);
// });
//
Deno.test("ordered consumers - consume", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf(), {
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());

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

Deno.test("ordered consumers - next stream not found", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["hello"] });

  const js = jetstream(nc);
  const c = await js.consumers.get("A");
  await jsm.streams.delete("A");

  await assertRejects(
    () => {
      return c.next({ expires: 1000 });
    },
    Error,
    "stream not found",
  );

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - fetch stream not found", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  const js = jetstream(nc);
  const c = await js.consumers.get("A");

  await jsm.streams.delete("A");

  const iter = await c.fetch({
    expires: 3000,
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

Deno.test("ordered consumers - consume stream not found request abort", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());

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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());

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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  const js = jetstream(nc);
  const c = await js.consumers.get("A");

  await assertRejects(
    () => {
      return c.next({ bind: true });
    },
    Error,
    "bind is not supported",
  );

  await assertRejects(
    () => {
      return c.fetch({ bind: true });
    },
    Error,
    "bind is not supported",
  );

  await assertRejects(
    () => {
      return c.consume({ bind: true });
    },
    Error,
    "bind is not supported",
  );

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - name prefix", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());

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
    "invalid name_prefix name - name_prefix name cannot contain '.'",
  );

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - fetch reset", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  await js.publish("a", JSON.stringify(1));

  const c = await js.consumers.get("A") as PullConsumerImpl;

  let recreates = 0;
  function countResets(iter: ConsumerMessages): Promise<void> {
    return (async () => {
      for await (const s of iter.status()) {
        if (s.type === ConsumerEvents.OrderedConsumerRecreated) {
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  await js.publish("a", JSON.stringify(1));

  let recreates = 0;
  function countRecreates(iter: ConsumerMessages): Promise<void> {
    return (async () => {
      for await (const s of iter.status()) {
        if (s.type === ConsumerEvents.OrderedConsumerRecreated) {
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

Deno.test("ordered consumers - next reset", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  assertExists(m)
  assertEquals(m.json(), 2);
  assertEquals(c.serial, 2);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - no reset on next", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
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

Deno.test("ordered consumers - stale reference recovers", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jsm.jetstream();
  await js.publish("a", JSON.stringify(1));
  await js.publish("a", JSON.stringify(2));

  const c = await js.consumers.get("A") as PullConsumerImpl;
  let m = await c.next({ expires: 1000 });
  assertExists(m);
  assertEquals(m.json<number>(), 1);
  assert(await jsm.consumers.delete("A", c.name));

  // continue until the server says the consumer doesn't exist
  while (true) {
    try {
      await c.info();
    } catch (_) {
      break;
    }
  }

  // so should get that error once
  await assertRejects(
    () => {
      return c.next({ expires: 1000 });
    },
    Error,
    "consumer not found",
  );

  // but now it will be created in line

  m = await c.next({ expires: 1000 });
  assertExists(m);
  assertEquals(m.json<number>(), 2);

  await cleanup(ns, nc);
});

Deno.test("ordered consumers - consume stale reference recovers", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const js = jetstream(nc);
  await js.publish("a", JSON.stringify(1));

  const c = await js.consumers.get("A") as PullConsumerImpl;
  await c.delete();
  while (true) {
    try {
      await c.info();
    } catch (_) {
      // if we are here, consumer not found
      break;
    }
  }

  const iter = await c.consume({ idle_heartbeat: 1_000, expires: 30_000 });

  let recreates = 0;
  function countRecreates(iter: ConsumerMessages): Promise<void> {
    return (async () => {
      for await (const s of iter.status()) {
        if (s.type === ConsumerEvents.OrderedConsumerRecreated) {
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
});
