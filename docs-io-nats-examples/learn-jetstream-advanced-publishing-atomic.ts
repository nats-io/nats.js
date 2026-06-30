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
import { jetstream, jetstreamManager } from "@nats-io/jetstream";

// connect to NATS demo server
const nc = await connect({ servers: "nats://localhost:4222" });

// create the ORDERS stream with atomic batches turned on, so a publish either
// lands every staged message or none of them. add() is idempotent.
const jsm = await jetstreamManager(nc);
await jsm.streams.add({
  name: "ORDERS",
  subjects: ["orders.>"],
  allow_atomic: true,
});

// get a JetStream context for publishing
const js = jetstream(nc);

// the three line items that make up one order
const lineItems = [
  `{"order_id":"ord_8w2k","sku":"NATS-MUG","qty":2}`,
  `{"order_id":"ord_8w2k","sku":"NATS-TEE","qty":1}`,
  `{"order_id":"ord_8w2k","sku":"NATS-CAP","qty":3}`,
];

// NATS-DOC-START
// Atomic batch: all three line items of order ord_8w2k reach the stream
// together, or none of them do. startBatch() opens the batch with the first
// item, add() stages the next without its own round trip, and commit()
// publishes the last item and seals the batch. The server stores every staged
// message at once and answers with a single ack for the whole batch.
const batch = await js.startBatch("orders.created", lineItems[0]);
batch.add("orders.created", lineItems[1]);
const ack = await batch.commit("orders.created", lineItems[2]);
console.log(`batch ${ack.batch} stored ${ack.count} line items`);
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
