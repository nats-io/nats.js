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
  jetstreamManager,
  JetStreamApiError,
  RetentionPolicy,
} from "@nats-io/jetstream";

// connect to NATS demo server
const nc = await connect({ servers: "nats://localhost:4222" });

// get a manager and make sure the FULFILLMENT WorkQueue stream exists
const jsm = await jetstreamManager(nc);
await jsm.streams.add({
  name: "FULFILLMENT",
  subjects: ["fulfill.>"],
  retention: RetentionPolicy.Workqueue,
});

// NATS-DOC-START
// One unfiltered consumer reads every subject in the queue. On a WorkQueue
// stream that is fine on its own.
await jsm.consumers.add("FULFILLMENT", {
  durable_name: "shippers",
  ack_policy: AckPolicy.Explicit,
});
console.log("Created consumer: shippers");

// A WorkQueue stream hands each task to exactly one consumer, so two unfiltered
// consumers would both claim the same subjects. The server rejects the second
// one with err 10099.
try {
  await jsm.consumers.add("FULFILLMENT", {
    durable_name: "eu-shippers",
    ack_policy: AckPolicy.Explicit,
  });
} catch (err) {
  if (err instanceof JetStreamApiError) {
    console.log(`Rejected (err ${err.code}): ${err.message}`);
  } else {
    throw err;
  }
}

// Give each worker its own slice of the queue instead. Drop the unfiltered
// consumer, then create one consumer per region. Their filters do not overlap,
// so both are allowed.
await jsm.consumers.delete("FULFILLMENT", "shippers");

await jsm.consumers.add("FULFILLMENT", {
  durable_name: "us-shippers",
  ack_policy: AckPolicy.Explicit,
  filter_subject: "fulfill.us",
});
await jsm.consumers.add("FULFILLMENT", {
  durable_name: "eu-shippers",
  ack_policy: AckPolicy.Explicit,
  filter_subject: "fulfill.eu",
});
console.log("Created filtered consumers: us-shippers, eu-shippers");
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
