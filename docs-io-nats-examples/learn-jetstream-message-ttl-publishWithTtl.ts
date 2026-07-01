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

// connect to NATS
const nc = await connect({ servers: "nats://localhost:4222" });

// get a manager and make sure ORDERS allows per-message TTLs. The stream must
// enable `allow_msg_ttl` before any `Nats-TTL` header is honored.
const jsm = await jetstreamManager(nc);
await jsm.streams.add({
  name: "ORDERS",
  subjects: ["orders.>"],
  allow_msg_ttl: true,
});

// get a JetStream context to publish with
const js = jetstream(nc);

// NATS-DOC-START
// Publish one order with a per-message TTL. The `ttl` option sets the
// `Nats-TTL` header ("60s"), so the server deletes this message 60 seconds
// after it is stored, even if the stream would otherwise keep it forever.
const pa = await js.publish("orders.cancelled", "order ord_8w2k cancelled", {
  ttl: "60s",
});
console.log(`Stored in ${pa.stream} at sequence ${pa.seq}`);
console.log("This message is deleted 60s after it was stored");
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
