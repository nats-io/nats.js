import {
  AckPolicy,
  DeliverPolicy,
  isPullConsumer,
  isPushConsumer,
  jetstream,
  jetstreamManager,
} from "../src/mod.ts";
import { isBoundPushConsumerOptions } from "../src/types.ts";
import { cleanup, jetstreamServerConf, Lock, NatsServer, setup } from "nst";
import { errors, nanos } from "@nats-io/nats-core";
import type { NatsConnection } from "@nats-io/nats-core";
import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertInstanceOf,
} from "@std/assert";
import type { PushConsumerMessagesImpl } from "../src/pushconsumer.ts";
import { deadline, delay } from "@nats-io/nats-core/internal";

Deno.test("push consumers - basics", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["A.*"] });
  await Promise.all([
    js.publish("A.a"),
    js.publish("A.b"),
    js.publish("A.c"),
  ]);

  const opts = {
    durable_name: "B",
    deliver_subject: "hello",
    deliver_policy: DeliverPolicy.All,
    idle_heartbeat: nanos(5000),
    flow_control: true,
    ack_policy: AckPolicy.Explicit,
  };
  assert(isBoundPushConsumerOptions(opts));
  await jsm.consumers.add("A", opts);

  const c = await js.consumers.getPushConsumer("A", "B");
  assert(isPushConsumer(c));
  assertFalse(isPullConsumer(c));

  let info = await c.info(true);
  assertEquals(info.config.deliver_group, undefined);

  const iter = await c.consume();
  await (async () => {
    for await (const m of iter) {
      m.ackAck().then(() => {
        if (m.info.streamSequence === 3) {
          iter.stop();
        }
      });
    }
  })();

  await iter.closed();

  info = await c.info();
  assertEquals(info.num_pending, 0);
  assertEquals(info.delivered.stream_seq, 3);
  assertEquals(info.ack_floor.stream_seq, 3);

  await cleanup(ns, nc);
});

Deno.test("push consumers - basics cb", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["A.*"] });
  await Promise.all([
    js.publish("A.a"),
    js.publish("A.b"),
    js.publish("A.c"),
  ]);

  await jsm.consumers.add("A", {
    durable_name: "B",
    deliver_subject: "hello",
    deliver_policy: DeliverPolicy.All,
    idle_heartbeat: nanos(5000),
    flow_control: true,
    ack_policy: AckPolicy.Explicit,
  });

  const c = await js.consumers.getPushConsumer("A", "B");
  let info = await c.info(true);
  assertEquals(info.config.deliver_group, undefined);

  const iter = await c.consume({
    callback: (m) => {
      m.ackAck()
        .then(() => {
          if (m.info.pending === 0) {
            iter.stop();
          }
        });
    },
  });

  await iter.closed();

  assertEquals(iter.getProcessed(), 3);

  info = await c.info();
  assertEquals(info.num_pending, 0);
  assertEquals(info.delivered.stream_seq, 3);
  assertEquals(info.ack_floor.stream_seq, 3);

  await cleanup(ns, nc);
});

Deno.test("push consumers - queue", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        max_file_store: 1024 * 1024 * 1024,
      },
    }),
  );
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["A.*"] });

  let info = await jsm.consumers.add("A", {
    durable_name: "B",
    deliver_subject: "here",
    deliver_group: "q",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });

  assertEquals(info.config.deliver_subject, "here");
  assertEquals(info.config.deliver_group, "q");

  const lock = Lock(1000, 0);

  const c = await js.consumers.getPushConsumer("A", "B");
  info = await c.info(true);
  assertEquals(info.config.deliver_group, "q");

  const c2 = await js.consumers.getPushConsumer("A", "B");
  info = await c2.info(true);
  assertEquals(info.config.deliver_group, "q");

  const iter = await c.consume();
  (async () => {
    for await (const m of iter) {
      m.ack();
      lock.unlock();
    }
  })().then();

  const iter2 = await c2.consume();
  (async () => {
    for await (const m of iter2) {
      m.ack();
      lock.unlock();
    }
  })().then();

  const buf = [];
  for (let i = 0; i < 1000; i++) {
    buf.push(js.publish(`A.${i}`));
    if (buf.length % 500 === 0) {
      await Promise.all(buf);
      buf.length = 0;
    }
  }

  await lock;
  assert(iter.getProcessed() > 0);
  assert(iter2.getProcessed() > 0);

  info = await c.info(false);
  assertEquals(info.delivered.consumer_seq, 1000);
  assertEquals(info.num_pending, 0);
  assertEquals(info.push_bound, true);

  await cleanup(ns, nc);
});

Deno.test("push consumers - connection status iterator closes", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf(),
  );
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["A.*"] });

  await jsm.consumers.add("A", {
    durable_name: "B",
    deliver_subject: "here",
    idle_heartbeat: nanos(1000),
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });

  const c = await js.consumers.getPushConsumer("A", "B");
  const msgs = await c.consume({
    callback: (m) => {
      m.ack();
    },
  }) as PushConsumerMessagesImpl;

  await delay(1000);

  assertExists(msgs.statusIterator);
  await msgs.close();
  assert(msgs.statusIterator.done);

  await cleanup(ns, nc);
});

Deno.test("push consumers - connection close closes", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf(),
  );
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["A.*"] });

  await jsm.consumers.add("A", {
    durable_name: "B",
    deliver_subject: "here",
    idle_heartbeat: nanos(1000),
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });

  const c = await js.consumers.getPushConsumer("A", "B");
  const iter = await c.consume({
    callback: (m) => {
      m.ack();
    },
  }) as PushConsumerMessagesImpl;

  await nc.close();
  await deadline(iter.closed(), 1000);

  await cleanup(ns, nc);
});

// reader can use the JS API but cannot respond to flow control ($JS.FC.>)
async function deniedFlowControlSetup(): Promise<
  { ns: NatsServer; w: NatsConnection; r: NatsConnection }
> {
  const ns = await NatsServer.start(jetstreamServerConf({
    jetstream: {
      max_file_store: 1024 * 1024 * 1024,
      max_mem_store: 1024 * 1024 * 1024,
    },
    authorization: {
      users: [
        { user: "writer", password: "writer" },
        {
          user: "reader",
          password: "reader",
          permissions: {
            publish: { allow: ["$JS.API.>"] },
            subscribe: { allow: ["_INBOX.>"] },
          },
        },
      ],
    },
  }));
  const w = await ns.connect({ user: "writer", pass: "writer" });
  const jsm = await jetstreamManager(w);
  await jsm.streams.add({ name: "A", subjects: ["a", "b"] });
  const js = jetstream(w);
  await js.publish("b");
  const payload = new Uint8Array(64 * 1024);
  for (let i = 0; i < 100; i++) {
    await js.publish("a", payload);
  }
  const r = await ns.connect({ user: "reader", pass: "reader" });
  return { ns, w, r };
}

async function drainExpectingError(
  iter: AsyncIterable<unknown>,
): Promise<Error | null> {
  try {
    await deadline(
      (async () => {
        for await (const _m of iter) {
          // nothing
        }
      })(),
      10_000,
    );
  } catch (err) {
    return err as Error;
  }
  return null;
}

Deno.test("push consumers - ordered fails if flow control is denied", async () => {
  const { ns, w, r } = await deniedFlowControlSetup();
  const c = await jetstream(r).consumers.getPushConsumer("A");
  const iter = await c.consume();
  const err = await drainExpectingError(iter);
  assertInstanceOf(err, errors.PermissionViolationError);
  assertEquals(err.operation, "publish");
  assert(err.subject.startsWith("$JS.FC.A."));
  assertEquals(await iter.closed(), err);
  // status listener is released
  const nci = r as unknown as { protocol: { listeners: unknown[] } };
  assertEquals(nci.protocol.listeners.length, 0);
  await cleanup(ns, w, r);
});

Deno.test("push consumers - fails if flow control is denied", async () => {
  const { ns, w, r } = await deniedFlowControlSetup();
  await jetstreamManager(w).then((jsm) =>
    jsm.consumers.add("A", {
      durable_name: "B",
      deliver_subject: "_INBOX.fc",
      ack_policy: AckPolicy.None,
      flow_control: true,
      idle_heartbeat: nanos(1000),
    })
  );
  const c = await jetstream(r).consumers.getPushConsumer("A", "B");
  const iter = await c.consume();
  const err = await drainExpectingError(iter);
  assertInstanceOf(err, errors.PermissionViolationError);
  assertEquals(err.operation, "publish");
  assert(err.subject.startsWith("$JS.FC.A.B."));
  await cleanup(ns, w, r);
});

Deno.test("push consumers - ordered flow control denial only fails matching consumer", async () => {
  const { ns, w, r } = await deniedFlowControlSetup();
  const js = jetstream(r);
  // "foo" only sees a tiny message and never needs flow control
  const small = await js.consumers.getPushConsumer("A", {
    name_prefix: "foo",
    filter_subjects: ["b"],
  });
  const smallIter = await small.consume();
  const smallDone = (async () => {
    for await (const _m of smallIter) {
      // nothing
    }
  })().catch((err) => err);
  // "foo_bar" extends the "foo" prefix and needs flow control
  const big = await js.consumers.getPushConsumer("A", {
    name_prefix: "foo_bar",
    filter_subjects: ["a"],
  });
  const bigIter = await big.consume();
  const err = await drainExpectingError(bigIter);
  assertInstanceOf(err, errors.PermissionViolationError);
  assert(err.subject.startsWith("$JS.FC.A.foo_bar_"));

  const closed = await Promise.race([
    smallIter.closed().then(() => true),
    delay(500).then(() => false),
  ]);
  assertFalse(closed, "unrelated ordered consumer was stopped");
  await smallIter.close();
  assertEquals(await smallDone, undefined);
  await cleanup(ns, w, r);
});
