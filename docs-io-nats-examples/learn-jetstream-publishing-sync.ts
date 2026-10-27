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
import { jetstream } from "@nats-io/jetstream";

// connect to NATS demo server
const nc = await connect({ servers: "nats://localhost:4222" });

// get a JetStream context; the ORDERS stream already captures `orders.>`
const js = jetstream(nc);

// NATS-DOC-START
// Publish three orders and read each PubAck, which confirms the stream that
// stored the message and the sequence it was assigned
const orders = [
  {
    subject: "orders.created",
    data:
      `{"order_id":"ord_8w2k","customer":"acme-co","total_cents":4200,"ts":"2026-05-22T10:14:22Z"}`,
  },
  {
    subject: "orders.created",
    data:
      `{"order_id":"ord_2zr9","customer":"globex","total_cents":7800,"ts":"2026-05-22T10:14:25Z"}`,
  },
  {
    subject: "orders.shipped",
    data:
      `{"order_id":"ord_8w2k","customer":"acme-co","total_cents":4200,"ts":"2026-05-22T10:14:31Z"}`,
  },
];

for (const order of orders) {
  const pa = await js.publish(order.subject, order.data);
  console.log(`Stored in ${pa.stream}, sequence ${pa.seq}`);
}
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
