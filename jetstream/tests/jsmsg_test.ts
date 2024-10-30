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
import { assertEquals, assertRejects, fail } from "jsr:@std/assert";
import {
  AckPolicy,
  jetstream,
  jetstreamManager,
  StorageType,
} from "../src/mod.ts";

import { createInbox, Empty, nanos } from "@nats-io/nats-core";
import type { Msg, MsgImpl } from "@nats-io/nats-core/internal";

import type { JsMsgImpl } from "../src/jsmsg.ts";
import { parseInfo, toJsMsg } from "../src/jsmsg.ts";
import {
  _setup,
  assertBetween,
  cleanup,
  connect,
  jetstreamServerConf,
} from "test_helpers";
import type { JetStreamManagerImpl } from "../src/jsclient.ts";
import { errors } from "../../core/src/mod.ts";

Deno.test("jsmsg - parse", () => {
  // "$JS.ACK.<stream>.<consumer>.<redeliveryCount><streamSeq><deliverySequence>.<timestamp>.<pending>"
  const rs = `$JS.ACK.streamname.consumername.2.3.4.${nanos(Date.now())}.100`;
  const info = parseInfo(rs);
  assertEquals(info.stream, "streamname");
  assertEquals(info.consumer, "consumername");
  assertEquals(info.redeliveryCount, 2);
  assertEquals(info.streamSequence, 3);
  assertEquals(info.pending, 100);
});

Deno.test("jsmsg - parse long", () => {
  // $JS.ACK.<domain>.<accounthash>.<stream>.<consumer>.<redeliveryCount>.<streamSeq>.<deliverySequence>.<timestamp>.<pending>.<random>
  const rs = `$JS.ACK.domain.account.streamname.consumername.2.3.4.${
    nanos(Date.now())
  }.100.rand`;
  const info = parseInfo(rs);
  assertEquals(info.domain, "domain");
  assertEquals(info.account_hash, "account");
  assertEquals(info.stream, "streamname");
  assertEquals(info.consumer, "consumername");
  assertEquals(info.redeliveryCount, 2);
  assertEquals(info.streamSequence, 3);
  assertEquals(info.pending, 100);
});

Deno.test("jsmsg - parse rejects subject is not 9 tokens", () => {
  const fn = (s: string, ok: boolean) => {
    try {
      parseInfo(s);
      if (!ok) {
        fail(`${s} should have failed to parse`);
      }
    } catch (err) {
      if (ok) {
        fail(`${s} shouldn't have failed to parse: ${(err as Error).message}`);
      }
    }
  };

  const chunks = `$JS.ACK.stream.consumer.1.2.3.4.5.6.7.8.9.10`.split(".");
  for (let i = 1; i <= chunks.length; i++) {
    fn(chunks.slice(0, i).join("."), i === 9 || i >= 12);
  }
});

Deno.test("jsmsg - acks", async () => {
  const nc = await connect({ servers: "demo.nats.io" });
  const subj = createInbox();

  // something that puts a reply that we can test
  let counter = 1;
  nc.subscribe(subj, {
    callback: (err, msg) => {
      if (err) {
        fail(err.message);
      }
      msg.respond(Empty, {
        // "$JS.ACK.<stream>.<consumer>.<redeliveryCount><streamSeq><deliverySequence>.<timestamp>.<pending>"
        reply:
          `MY.TEST.streamname.consumername.1.${counter}.${counter}.${Date.now()}.0`,
      });
      counter++;
    },
  });

  // something to collect the replies
  const replies: Msg[] = [];
  nc.subscribe("MY.TEST.*.*.*.*.*.*.*", {
    callback: (err, msg) => {
      if (err) {
        fail(err.message);
      }
      replies.push(msg);
    },
  });

  // nak
  let msg = await nc.request(subj);
  let js = toJsMsg(msg);
  js.nak();

  // working
  msg = await nc.request(subj);
  js = toJsMsg(msg);
  js.working();

  // working
  msg = await nc.request(subj);
  js = toJsMsg(msg);
  js.term();

  msg = await nc.request(subj);
  js = toJsMsg(msg);
  js.ack();
  await nc.flush();

  assertEquals(replies.length, 4);
  const sc = new TextDecoder();
  assertEquals(sc.decode(replies[0].data), "-NAK");
  assertEquals(sc.decode(replies[1].data), "+WPI");
  assertEquals(sc.decode(replies[2].data), "+TERM");
  assertEquals(sc.decode(replies[3].data), "+ACK");

  await nc.close();
});

Deno.test("jsmsg - no ack consumer is ackAck 503", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a.>"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  const js = jetstream(nc);
  await js.publish("a.a");

  await jsm.consumers.add("A", { durable_name: "a" });
  const c = await js.consumers.get("A", "a");
  const jm = await c.next();

  await assertRejects(
    (): Promise<boolean> => {
      return jm!.ackAck();
    },
    errors.RequestError,
    "no responders",
  );

  await cleanup(ns, nc);
});

Deno.test("jsmsg - explicit consumer ackAck", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a.>"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  const js = jetstream(nc);
  await js.publish("a.a");

  await jsm.consumers.add("A", {
    durable_name: "a",
    ack_policy: AckPolicy.Explicit,
  });
  const c = await js.consumers.get("A", "a");
  const jm = await c.next();
  assertEquals(await jm?.ackAck(), true);
  assertEquals(await jm?.ackAck(), false);

  await cleanup(ns, nc);
});

Deno.test("jsmsg - explicit consumer ackAck timeout", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a.>"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  const js = jetstream(nc);
  await js.publish("a.a");

  await jsm.consumers.add("A", { durable_name: "a" });
  const c = await js.consumers.get("A", "a");
  const jm = await c.next();
  // change the subject
  ((jm as JsMsgImpl).msg as MsgImpl)._reply = "xxxx";
  nc.subscribe("xxxx");
  const start = Date.now();
  await assertRejects(
    (): Promise<boolean> => {
      return jm!.ackAck({ timeout: 1000 });
    },
    errors.TimeoutError,
  );
  assertBetween(Date.now() - start, 1000, 1500);

  await cleanup(ns, nc);
});

Deno.test("jsmsg - ackAck js options timeout", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a.>"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  // default is 5000
  const js = jetstream(nc, { timeout: 1500 });
  await js.publish("a.a");

  await jsm.consumers.add("A", { durable_name: "a" });
  const c = await js.consumers.get("A", "a");
  const jm = await c.next();
  // change the subject
  ((jm as JsMsgImpl).msg as MsgImpl)._reply = "xxxx";
  nc.subscribe("xxxx");
  const start = Date.now();
  await assertRejects(
    (): Promise<boolean> => {
      return jm!.ackAck();
    },
    errors.TimeoutError,
  );
  assertBetween(Date.now() - start, 1300, 1700);

  await cleanup(ns, nc);
});

Deno.test("jsmsg - ackAck legacy timeout", async () => {
  const { ns, nc } = await _setup(connect, jetstreamServerConf());
  const jsm = await jetstreamManager(nc) as JetStreamManagerImpl;
  await jsm.streams.add({
    name: "A",
    subjects: ["a.>"],
    storage: StorageType.Memory,
    allow_direct: true,
  });

  // default is 5000
  const js = jetstream(nc, { timeout: 1500 });
  await js.publish("a.a");

  await jsm.consumers.add("A", { durable_name: "a" });
  const c = await js.consumers.get("A", "a");
  const jm = await c.next();
  // change the subject
  ((jm as JsMsgImpl).msg as MsgImpl)._reply = "xxxx";
  nc.subscribe("xxxx");
  const start = Date.now();
  await assertRejects(
    (): Promise<boolean> => {
      return jm!.ackAck();
    },
    errors.TimeoutError,
  );
  assertBetween(Date.now() - start, 1300, 1700);

  await cleanup(ns, nc);
});
