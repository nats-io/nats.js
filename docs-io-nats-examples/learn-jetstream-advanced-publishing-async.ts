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
// Async publish: call publish() for every order WITHOUT awaiting each one, so
// the round trips overlap. Collect the promises, await them together, then
// check each result -- a rejected promise is a failed publish you must retry.
const orders = [
  `{"order_id":"ord_8w2k","customer":"acme-co","total_cents":4200}`,
  `{"order_id":"ord_2zr9","customer":"globex","total_cents":7800}`,
  `{"order_id":"ord_5t1m","customer":"initech","total_cents":1500}`,
  `{"order_id":"ord_9p3x","customer":"hooli","total_cents":9900}`,
];

const pending = orders.map((order) => js.publish("orders.created", order));
const results = await Promise.allSettled(pending);

results.forEach((result, i) => {
  if (result.status === "fulfilled") {
    console.log(`order ${i + 1} stored at sequence ${result.value.seq}`);
  } else {
    console.log(`order ${i + 1} failed, re-publish it: ${result.reason}`);
  }
});
// NATS-DOC-END

await nc.drain();
