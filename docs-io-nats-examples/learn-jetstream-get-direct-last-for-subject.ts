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
import { jetstreamManager } from "@nats-io/jetstream";

// connect to NATS
const nc = await connect({ servers: "nats://localhost:4222" });

// get a JetStream manager
const jsm = await jetstreamManager(nc);

// NATS-DOC-START
// Read the last message stored on subject orders.shipped through the regular
// get API, which is served by the stream leader.
const m = await jsm.streams.getMessage("ORDERS", {
  last_by_subj: "orders.shipped",
});
console.log(`subject: ${m?.subject}`);
console.log(`payload: ${m?.string()}`);
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
