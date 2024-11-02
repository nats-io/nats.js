/*
 * Copyright 2021-2023 The NATS Authors
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
  assertBetween,
  cleanup,
  connect,
  jetstreamExportServerConf,
  jetstreamServerConf,
  notCompatible,
  setup,
} from "test_helpers";
import { initStream } from "./jstest_util.ts";
import {
  createInbox,
  DebugEvents,
  deferred,
  delay,
  Empty,
  Events,
  InvalidArgumentError,
  nanos,
  nuid,
  syncIterator,
} from "@nats-io/nats-core";
import { ConsumerDebugEvents, ConsumerEvents } from "../src/types.ts";
import type { BoundPushConsumerOptions, PubAck } from "../src/types.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
} from "jsr:@std/assert";
import { AckPolicy, DeliverPolicy, StorageType } from "../src/jsapi_types.ts";
import type { JsMsg } from "../src/jsmsg.ts";
import { jetstream, jetstreamManager } from "../src/mod.ts";
import type {
  PushConsumerImpl,
  PushConsumerMessagesImpl,
} from "../src/pushconsumer.ts";
import type { NatsConnectionImpl } from "@nats-io/nats-core/internal";

Deno.test("jetstream - durable", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const js = jetstream(nc);
  await js.publish(subj);

  const jsm = await js.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    deliver_subject: createInbox(),
  });

  const c = await js.consumers.getPushConsumer(stream, "me");
  const iter = await c.consume();
  for await (const m of iter) {
    m.ack();
    break;
  }

  // consumer should exist
  const ci = await c.info();
  assertEquals(ci.name, "me");

  // delete the consumer
  await c.delete();
  await assertRejects(
    async () => {
      await c.info();
    },
    Error,
    "consumer not found",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - queue error checks", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.3.5")) {
    return;
  }
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  await assertRejects(
    async () => {
      await jsm.consumers.add(stream, {
        durable_name: "me",
        deliver_subject: "x",
        deliver_group: "x",
        idle_heartbeat: nanos(1000),
      });
    },
    Error,
    "'idle_heartbeat','deliver_group' are mutually exclusive",
    undefined,
  );

  await assertRejects(
    async () => {
      await jsm.consumers.add(stream, {
        durable_name: "me",
        deliver_subject: "x",
        deliver_group: "x",
        flow_control: true,
      });
    },
    InvalidArgumentError,
    "'flow_control','deliver_group' are mutually exclusive",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - max ack pending", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const jsm = await jetstreamManager(nc);
  const d = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
  const buf: Promise<PubAck>[] = [];
  const js = jetstream(nc);
  d.forEach((v) => {
    buf.push(js.publish(subj, v, { msgID: v }));
  });
  await Promise.all(buf);

  const consumers = await jsm.consumers.list(stream).next();
  assert(consumers.length === 0);

  const ci = await jsm.consumers.add(
    stream,
    {
      max_ack_pending: 2,
      ack_policy: AckPolicy.Explicit,
      deliver_subject: createInbox(),
    },
  );

  const c = await js.consumers.getPushConsumer(stream, ci.name);
  const iter = await c.consume();

  await (async () => {
    for await (const m of iter) {
      assert(
        iter.getPending() < 3,
        `didn't expect pending messages greater than 2`,
      );
      m.ack();
      if (m.info.pending === 0) {
        break;
      }
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("jetstream - deliver new", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { subj, stream } = await initStream(nc);

  const js = jetstream(nc);
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 3 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 4 } });

  const jsm = await js.jetstreamManager();
  const ci = await jsm.consumers.add(stream, {
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    deliver_subject: createInbox(),
  });

  const c = await js.consumers.getPushConsumer(stream, ci.name);
  const iter = await c.consume();
  const done = (async () => {
    for await (const m of iter) {
      assertEquals(m.seq, 6);
      break;
    }
  })();

  await js.publish(subj, Empty, { expect: { lastSequence: 5 } });
  await done;
  await cleanup(ns, nc);
});

Deno.test("jetstream - deliver last", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { subj, stream } = await initStream(nc);

  const js = jetstream(nc);
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 3 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 4 } });

  const jsm = await js.jetstreamManager();
  const ci = await jsm.consumers.add(stream, {
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.Last,
    deliver_subject: createInbox(),
  });

  const c = await js.consumers.getPushConsumer(stream, ci.name);
  const iter = await c.consume();
  const done = (async () => {
    for await (const m of iter) {
      assertEquals(m.seq, 5);
      break;
    }
  })();

  await done;
  await cleanup(ns, nc);
});

Deno.test("jetstream - deliver seq", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { subj, stream } = await initStream(nc);

  const js = jetstream(nc);
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 3 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 4 } });

  const jsm = await js.jetstreamManager();
  const ci = await jsm.consumers.add(stream, {
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.StartSequence,
    opt_start_seq: 2,
    deliver_subject: createInbox(),
  });

  const c = await js.consumers.getPushConsumer(stream, ci.name);
  const iter = await c.consume();
  const done = (async () => {
    for await (const m of iter) {
      assertEquals(m.seq, 2);
      break;
    }
  })();
  await done;
  await cleanup(ns, nc);
});

Deno.test("jetstream - deliver start time", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { subj, stream } = await initStream(nc);

  const js = jetstream(nc);
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });

  await delay(1000);
  const now = new Date();
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });

  const jsm = await js.jetstreamManager();
  const ci = await jsm.consumers.add(stream, {
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.StartTime,
    opt_start_time: now.toISOString(),
    deliver_subject: createInbox(),
  });

  const sub = await js.consumers.getPushConsumer(stream, ci.name);
  const iter = await sub.consume();
  const done = (async () => {
    for await (const m of iter) {
      assertEquals(m.seq, 3);
      break;
    }
  })();
  await done;
  await cleanup(ns, nc);
});

Deno.test("jetstream - deliver last per subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc)) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add(
    { name: stream, subjects: [subj] },
  );

  const js = jetstream(nc);
  await js.publish(`${stream}.A`, Empty, { expect: { lastSequence: 0 } });
  await js.publish(`${stream}.B`, Empty, { expect: { lastSequence: 1 } });
  await js.publish(`${stream}.A`, Empty, { expect: { lastSequence: 2 } });
  await js.publish(`${stream}.B`, Empty, { expect: { lastSequence: 3 } });
  await js.publish(`${stream}.A`, Empty, { expect: { lastSequence: 4 } });
  await js.publish(`${stream}.B`, Empty, { expect: { lastSequence: 5 } });

  let ci = await jsm.consumers.add(stream, {
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.LastPerSubject,
    filter_subject: ">",
    deliver_subject: createInbox(),
  });

  const sub = await js.consumers.getPushConsumer(stream, ci.name);
  const iter = await sub.consume();
  const buf: JsMsg[] = [];
  const done = (async () => {
    for await (const m of iter) {
      buf.push(m);
      if (buf.length === 2) {
        break;
      }
    }
  })();

  await done;
  assertEquals(buf[0].info.streamSequence, 5);
  assertEquals(buf[1].info.streamSequence, 6);

  ci = await sub.info();
  assertEquals(ci.num_ack_pending, 2);
  await cleanup(ns, nc);
});

Deno.test("jetstream - cross account subscribe", async () => {
  const { ns, nc: admin } = await setup(jetstreamExportServerConf(), {
    user: "js",
    pass: "js",
  });

  // add a stream
  const { subj, stream } = await initStream(admin);
  const adminjs = jetstream(admin);
  await adminjs.publish(subj);
  await adminjs.publish(subj);

  const nc = await connect({
    port: ns.port,
    user: "a",
    pass: "s3cret",
    inboxPrefix: "A",
  });
  const js = jetstream(nc, { apiPrefix: "IPA" });
  const jsm = await js.jetstreamManager();
  let ci = await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    deliver_subject: createInbox("A"),
  });

  const acks: Promise<boolean>[] = [];

  const sub = await js.consumers.getPushConsumer(stream, ci.name);
  const messages = await sub.consume();
  await (async () => {
    for await (const m of messages) {
      acks.push(m.ackAck());
      if (m.seq === 2) {
        break;
      }
    }
  })();

  await Promise.all(acks);
  ci = await sub.info();
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 2);
  assertEquals(ci.ack_floor.stream_seq, 2);
  await sub.delete();
  await assertRejects(
    async () => {
      await sub.info();
    },
    Error,
    "consumer not found",
    undefined,
  );

  await cleanup(ns, admin, nc);
});

Deno.test("jetstream - ack lease extends with working", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const sn = nuid.next();
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: sn, subjects: [`${sn}.>`] });

  const js = jetstream(nc);
  await js.publish(`${sn}.A`, Empty, { msgID: "1" });

  const cc = {
    "ack_wait": nanos(2000),
    "deliver_subject": createInbox(),
    "ack_policy": AckPolicy.Explicit,
    "durable_name": "me",
  };
  const ci = await jsm.consumers.add(sn, cc);
  const c = await js.consumers.getPushConsumer(sn, ci.name);

  const messages = await c.consume();
  const done = (async () => {
    for await (const m of messages) {
      const timer = setInterval(() => {
        m.working();
      }, 750);
      // we got a message now we are going to delay for 31 sec
      await delay(15);
      const ci = await jsm.consumers.info(sn, "me");
      assertEquals(ci.num_ack_pending, 1);
      m.ack();
      clearInterval(timer);
      break;
    }
  })();

  await done;

  // make sure the message went out
  await nc.flush();
  const ci2 = await c.info();
  assertEquals(ci2.delivered.stream_seq, 1);
  assertEquals(ci2.num_redelivered, 0);
  assertEquals(ci2.num_ack_pending, 0);

  await cleanup(ns, nc);
});

Deno.test("jetstream - idle heartbeats", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const { stream, subj } = await initStream(nc);
  const js = jetstream(nc);
  await js.publish(subj);
  const jsm = await jetstreamManager(nc);
  const inbox = createInbox();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    deliver_subject: inbox,
    idle_heartbeat: nanos(2000),
  });

  const c = await js.consumers.getPushConsumer(stream, "me");
  const messages = await c.consume({
    callback: (_) => {
    },
  });

  const status = messages.status();

  for await (const s of status) {
    if (s.type === ConsumerDebugEvents.Heartbeat) {
      const d = s.data as {
        natsLastConsumer: string;
        natsLastStream: string;
      };

      assertEquals(d.natsLastConsumer, "1");
      assertEquals(d.natsLastStream, "1");
      messages.stop();
    }
  }

  await messages.closed();
  await cleanup(ns, nc);
});

Deno.test("jetstream - flow control", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        max_file_store: -1,
      },
    }),
  );

  const { stream, subj } = await initStream(nc);
  const data = new Uint8Array(1024 * 100);
  const js = jetstream(nc);
  const proms = [];
  for (let i = 0; i < 2000; i++) {
    proms.push(js.publish(subj, data));
    nc.publish(subj, data);
    if (proms.length % 100 === 0) {
      await Promise.all(proms);
      proms.length = 0;
    }
  }
  if (proms.length) {
    await Promise.all(proms);
  }
  await nc.flush();

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    deliver_subject: createInbox(),
    flow_control: true,
    idle_heartbeat: nanos(5000),
  });

  const c = await js.consumers.getPushConsumer(stream, "me");
  const iter = await c.consume({ callback: () => {} });
  const status = iter.status();
  for await (const s of status) {
    if (s.type === ConsumerDebugEvents.FlowControl) {
      iter.stop();
    }
  }

  await cleanup(ns, nc);
});

Deno.test("jetstream - durable resumes", async () => {
  let { ns, nc } = await setup(jetstreamServerConf({}), {
    maxReconnectAttempts: -1,
    reconnectTimeWait: 100,
  });

  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  let values = ["a", "b", "c"];
  for (const v of values) {
    await js.publish(subj, v);
  }

  await jsm.consumers.add(stream, {
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    deliver_subject: createInbox(),
    durable_name: "me",
  });

  const sub = await js.consumers.getPushConsumer(stream, "me");
  const iter = await sub.consume({
    callback: (m) => {
      m.ack();
      if (m.seq === 6) {
        iter.close();
      }
    },
  });

  await nc.flush();
  await ns.stop();
  ns = await ns.restart();
  await delay(300);
  values = ["d", "e", "f"];
  for (const v of values) {
    await js.publish(subj, v);
  }
  await nc.flush();
  await iter.closed();

  const si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 6);
  const ci = await sub.info();
  assertEquals(ci.delivered.stream_seq, 6);
  assertEquals(ci.num_pending, 0);

  await cleanup(ns, nc);
});

Deno.test("jetstream - nak delay", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.7.1")) {
    return;
  }

  const { subj, stream } = await initStream(nc);
  const js = jetstream(nc);
  await js.publish(subj);

  let start = 0;

  const jsm = await js.jetstreamManager();
  const ci = await jsm.consumers.add(stream, {
    ack_policy: AckPolicy.Explicit,
    deliver_subject: createInbox(),
  });

  const c = await js.consumers.getPushConsumer(stream, ci.name);
  const iter = await c.consume({
    callback: (m) => {
      if (m.redelivered) {
        m.ack();
        iter.close();
      } else {
        start = Date.now();
        m.nak(2000);
      }
    },
  });

  await iter.closed();

  const delay = Date.now() - start;
  assertBetween(delay, 1800, 2200);
  await cleanup(ns, nc);
});

Deno.test("jetstream - bind", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        max_file_store: -1,
      },
    }),
  );
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
  });

  const buf = [];
  const data = new Uint8Array(1024 * 100);
  for (let i = 0; i < 100; i++) {
    buf.push(js.publish(`${stream}.${i}`, data));
  }
  await Promise.all(buf);

  const ci = await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    deliver_subject: createInbox(),
    idle_heartbeat: nanos(1000),
    flow_control: true,
  });

  jsm.consumers.info = () => {
    return Promise.reject("called info");
  };

  console.log(ci.config);

  const c = await js.consumers.getBoundPushConsumer(
    ci.config as BoundPushConsumerOptions,
  );

  await assertRejects(
    () => {
      return c.info();
    },
    Error,
    "bound consumers cannot info",
  );

  await assertRejects(
    () => {
      return c.delete();
    },
    Error,
    "bound consumers cannot delete",
  );

  const messages = await c.consume();
  (async () => {
    for await (const m of messages) {
      m.ack();
      if (m.info.pending === 0) {
        await delay(3000);
        messages.stop();
      }
    }
  })().then();

  let fc = 0;
  let hb = 0;

  for await (const s of messages.status()) {
    if (s.type === ConsumerDebugEvents.FlowControl) {
      fc++;
    } else if (s.type === ConsumerDebugEvents.Heartbeat) {
      hb++;
    }
  }

  await messages.closed();

  assert(fc > 0);
  assert(hb > 0);
  assertEquals(messages.getProcessed(), 100);

  await cleanup(ns, nc);
});

Deno.test("jetstream - bind example", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const subj = `A.*`;
  await jsm.streams.add({
    name: "A",
    subjects: [subj],
  });

  const deliver_subject = createInbox();
  await jsm.consumers.add("A", {
    durable_name: "me",
    deliver_subject,
    ack_policy: AckPolicy.Explicit,
    idle_heartbeat: nanos(1000),
    flow_control: true,
  });

  const c = await js.consumers.getBoundPushConsumer({
    deliver_subject,
    idle_heartbeat: nanos(1000),
  });

  const messages = await c.consume();
  (async () => {
    for await (const m of messages) {
      m.ack();
      if (m.info.streamSequence === 100) {
        break;
      }
    }
  })().then();

  const status = messages.status();
  (async () => {
    for await (const s of status) {
      console.log(s);
    }
  })().then();

  const buf = [];
  for (let i = 0; i < 100; i++) {
    buf.push(js.publish(`A.${i}`, `${i}`));
    if (buf.length % 10) {
      await Promise.all(buf);
      buf.length = 0;
    }
  }

  await messages.closed();

  await cleanup(ns, nc);
});

Deno.test("jetstream - push consumer is bound", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "me",
    deliver_subject: "here",
  });

  const js = jsm.jetstream();
  const c = await js.consumers.getPushConsumer(stream, "me");
  let msgs = await c.consume({
    callback: (m) => {
      m.ack();
    },
  });

  await assertRejects(
    () => {
      return c.consume();
    },
    Error,
    "consumer already started",
  );

  // close and restart should be ok
  await msgs.close();
  msgs = await c.consume({
    callback: (m) => {
      m.ack();
    },
  });

  const c2 = await js.consumers.getPushConsumer(stream, "me");
  await assertRejects(
    () => {
      return c2.consume({
        callback: (m) => {
          m.ack();
        },
      });
    },
    Error,
    "consumer is already bound",
  );
  msgs.stop();

  await cleanup(ns, nc);
});

Deno.test("jetstream - idleheartbeats notifications don't cancel", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const js = jetstream(nc);
  const c = await js.consumers.getBoundPushConsumer({
    deliver_subject: "foo",
    idle_heartbeat: nanos(1000),
  });

  const msgs = await c.consume({ callback: () => {} });
  let missed = 0;
  for await (const s of msgs.status()) {
    if (s.type === ConsumerEvents.HeartbeatsMissed) {
      missed++;
      if (missed > 3) {
        await msgs.close();
      }
    }
  }

  await msgs.closed();
  await cleanup(ns, nc);
});

Deno.test("jetstream - push on stopped server doesn't close client", async () => {
  let { ns, nc } = await setup(jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });
  const reconnected = deferred<void>();
  (async () => {
    let reconnects = 0;
    for await (const s of nc.status()) {
      switch (s.type) {
        case DebugEvents.Reconnecting:
          reconnects++;
          if (reconnects === 2) {
            ns.restart().then((s) => {
              ns = s;
            });
          }
          break;
        case Events.Reconnect:
          setTimeout(() => {
            reconnected.resolve();
          }, 1000);
          break;
        default:
          // nothing
      }
    }
  })().then();
  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.add({ name: nuid.next(), subjects: ["test"] });
  const { name: stream } = si.config;

  const js = jetstream(nc);

  await jsm.consumers.add(stream, {
    durable_name: "dur",
    ack_policy: AckPolicy.Explicit,
    deliver_subject: "bar",
  });

  const c = await js.consumers.getPushConsumer(stream, "dur");
  const msgs = await c.consume({
    callback: (m) => {
      m.ack();
    },
  });

  setTimeout(() => {
    ns.stop();
  }, 2000);

  await reconnected;
  assertEquals(nc.isClosed(), false);
  assertEquals((msgs as PushConsumerMessagesImpl).sub.isClosed(), false);
  await cleanup(ns, nc);
});

Deno.test("jetstream - push sync", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
    deliver_subject: "here",
  });

  const js = jetstream(nc);

  await js.publish(name);
  await js.publish(name);

  const c = await js.consumers.getPushConsumer(name, name);
  const sync = syncIterator(await c.consume());
  assertExists(await sync.next());
  assertExists(await sync.next());

  await cleanup(ns, nc);
});

Deno.test("jetstream - ordered push consumer honors inbox prefix", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf(
      {
        authorization: {
          users: [{
            user: "a",
            password: "a",
            permission: {
              subscribe: ["my_inbox_prefix.>", "another.>"],
              publish: ">",
            },
          }],
        },
      },
    ),
    {
      user: "a",
      pass: "a",
      inboxPrefix: "my_inbox_prefix",
    },
  );
  const nci = nc as NatsConnectionImpl;
  assertEquals(nci.options.inboxPrefix, "my_inbox_prefix");

  const name = nuid.next();
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });

  const js = jsm.jetstream();
  await js.publish(name, "hello");

  let c = await js.consumers.getPushConsumer(name);
  let cc = c as PushConsumerImpl;
  // here the create inbox added another token
  assert(cc.opts.deliver_prefix?.startsWith("my_inbox_prefix."));

  let iter = await c.consume();
  for await (const m of iter) {
    m.ack();
    iter.stop();
  }

  // now check that if they gives a deliver prefix we use that
  // over the inbox
  c = await js.consumers.getPushConsumer(name, { deliver_prefix: "another" });
  cc = c as PushConsumerImpl;
  // here we are just the template
  assert(cc.opts.deliver_prefix?.startsWith("another"));

  iter = await c.consume();
  for await (const m of iter) {
    m.ack();
    iter.stop();
  }

  await cleanup(ns, nc);
});
