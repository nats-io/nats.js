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
import { AckPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";

// connect to NATS demo server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// ORDERS already holds orders.created and orders.shipped messages. Create a
// durable pull consumer that only sees one of those subjects: filter_subject
// "orders.shipped" tells the server to skip everything else. ack_policy Explicit
// means a reader acks each delivered message. add() is idempotent.
const jsm = await jetstreamManager(nc);
await jsm.consumers.add("ORDERS", {
  durable_name: "analytics",
  ack_policy: AckPolicy.Explicit,
  filter_subject: "orders.shipped",
});
console.log("Created filtered consumer: analytics (orders.shipped)");

// Bind to it and pull a small batch. Only orders.shipped come back — the filter
// drops orders.created before it ever reaches this consumer.
const js = jetstream(nc);
const c = await js.consumers.get("ORDERS", "analytics");
const msgs = await c.fetch({ max_messages: 5, expires: 2000 });
for await (const m of msgs) {
  console.log(m.subject);
  await m.ack();
}
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
