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
  DeliverPolicy,
  jetstreamManager,
} from "@nats-io/jetstream";

// connect to NATS demo server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Create a durable pull consumer on the ORDERS stream. The durable keeps its
// position under a fixed name, so a reader can come back later and pick up where
// it left off. ack_policy Explicit means the server only advances that position
// once a reader acks each message. deliver_policy All starts from the first
// stored message. add() is idempotent: calling it again with the same config is
// a no-op.
const jsm = await jetstreamManager(nc);
await jsm.consumers.add("ORDERS", {
  durable_name: "shipping",
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
});
console.log("Created durable consumer: shipping");
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
