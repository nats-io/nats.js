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
// Bind to the existing durable and pull one message with next(). nak() tells the
// server to redeliver instead of advancing. Passing a delay (in milliseconds)
// holds the redelivery for that long, which backs off a downstream that isn't
// ready yet.
const js = jetstream(nc);
const c = await js.consumers.get("ORDERS", "shipping");

const m = await c.next();
if (m) {
  console.log(`${m.subject}: ${m.string()}`);
  m.nak(10_000); // ask for redelivery after 10 seconds
} else {
  console.log("nothing to read");
}
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
