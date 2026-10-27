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
// The filter_subject here has a typo: "orders.shiped" matches no subject ORDERS
// actually stores. The server still accepts the consumer — a filter that matches
// nothing is valid, just empty.
const jsm = await jetstreamManager(nc);
await jsm.consumers.add("ORDERS", {
  durable_name: "analytics-typo",
  ack_policy: AckPolicy.Explicit,
  filter_subject: "orders.shiped",
});
console.log("Created filtered consumer: analytics-typo (orders.shiped)");

// Try to pull. The fetch waits out its short expiry and returns nothing — no
// error, no message. A wrong filter fails silently: the pull just times out
// empty because no stored subject matches.
const js = jetstream(nc);
const c = await js.consumers.get("ORDERS", "analytics-typo");
const msgs = await c.fetch({ max_messages: 5, expires: 2000 });
let count = 0;
for await (const m of msgs) {
  count++;
  await m.ack();
}
if (count === 0) {
  console.log("pull returned nothing: filter matched no stored subject");
}
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
