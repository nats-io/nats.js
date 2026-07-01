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
  jetstream,
  JetStreamApiError,
  jetstreamManager,
} from "@nats-io/jetstream";

// connect to NATS
const nc = await connect({ servers: "nats://localhost:4222" });

// get a manager and create a stream that does NOT enable per-message TTLs
// (no `allow_msg_ttl`), then get a JetStream context to publish with
const jsm = await jetstreamManager(nc);
await jsm.streams.add({
  name: "ORDERS_NO_TTL",
  subjects: ["no-ttl.>"],
});
const js = jetstream(nc);

// NATS-DOC-START
// Publish with a TTL to a stream that has per-message TTLs disabled. The server
// rejects the message with err 10166 ("per-message TTL is disabled") and stores
// nothing. Enabling `allow_msg_ttl` on the stream is the fix.
try {
  await js.publish("no-ttl.msg", "order ord_8w2k cancelled", { ttl: "60s" });
} catch (err) {
  if (err instanceof JetStreamApiError) {
    console.log(`Rejected (err ${err.code}): ${err.message}`);
    console.log("Nothing was stored");
  } else {
    throw err;
  }
}
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
