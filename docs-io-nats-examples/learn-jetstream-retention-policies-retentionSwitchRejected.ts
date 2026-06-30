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
// Retention is fixed at creation. Read the live config, flip it from WorkQueue
// to Limits, and submit the update. The server rejects the change with err
// 10052: it won't move a stream to or from workqueue retention. To change
// retention, create a new stream instead.
const fulfillment = await jsm.streams.info("FULFILLMENT");
fulfillment.config.retention = RetentionPolicy.Limits;
try {
  await jsm.streams.update("FULFILLMENT", fulfillment.config);
} catch (err) {
  if (err instanceof JetStreamApiError) {
    console.log(`Rejected (err ${err.code}): ${err.message}`);
  } else {
    throw err;
  }
}
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
