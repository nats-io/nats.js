/*
 * Copyright 2026 The NATS Authors
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

// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import {
  AckPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
} from "@nats-io/jetstream";

// connect to NATS demo server
const nc = await connect({ servers: "nats://localhost:4222" });

// get a JetStream context for publishing and consuming, and a manager for
// creating streams and consumers
const js = jetstream(nc);
const jsm = await jetstreamManager(nc);

// NATS-DOC-START
// FULFILLMENT is the queue of paid orders waiting to ship. WorkQueue retention
// means the stream holds each task only until a worker acks it, then drops it.
// That is the opposite of a Limits stream like ORDERS, which keeps the record.
const info = await jsm.streams.add({
  name: "FULFILLMENT",
  subjects: ["fulfill.>"],
  retention: RetentionPolicy.Workqueue,
});
console.log(`Created stream FULFILLMENT, retention: ${info.config.retention}`);

// Queue one order to ship in the US region.
const order = `{"order_id":"ord_8w2k","customer":"acme-co"}`;
const pa = await js.publish("fulfill.us", order);
console.log(`Queued ${pa.stream} seq ${pa.seq}`);

// A durable pull consumer drains the queue. WorkQueue streams require explicit
// ack, so the worker acks each task it finishes.
await jsm.consumers.add("FULFILLMENT", {
  durable_name: "shippers",
  ack_policy: AckPolicy.Explicit,
});

// Pull the order, ship it, and ack. ackAck waits for the server to confirm the
// ack landed, so the next read sees the result.
const c = await js.consumers.get("FULFILLMENT", "shippers");
const msgs = await c.fetch({ max_messages: 1, expires: 5000 });
for await (const m of msgs) {
  console.log(`Shipping ${m.subject}: ${m.string()}`);
  await m.ackAck();
}

// The ack removed the task, so the stream is now empty. A Limits stream would
// still hold the message; a WorkQueue stream drains to zero.
const after = await jsm.streams.info("FULFILLMENT");
console.log(`Messages in FULFILLMENT after ack: ${after.state.messages}`);
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
