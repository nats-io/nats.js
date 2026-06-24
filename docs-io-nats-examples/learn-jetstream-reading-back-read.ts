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

// NATS-DOC-START
// Bind to the existing durable and read every stored message in order. Ask the
// consumer how many are waiting (num_pending) instead of guessing a count, then
// fetch exactly that many. The ack_policy is none, so there's nothing to ack.
const js = jetstream(nc);
const c = await js.consumers.get("ORDERS", "orders-reader");
const info = await c.info();
const n = info.num_pending;

if (n === 0) {
  console.log("nothing to read");
} else {
  const msgs = await c.fetch({ max_messages: Number(n) });
  for await (const m of msgs) {
    console.log(
      `stream seq ${m.info.streamSequence}, delivery seq ${m.info.deliverySequence}: ${m.string()}`,
    );
  }
}
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
