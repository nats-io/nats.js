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

const jsm = await jetstreamManager(nc);

// Setup: the three regional streams ALL-ORDERS aggregates, each with its own subjects.
await jsm.streams.add({ name: "ORDERS-US", subjects: ["us.orders.>"] });
await jsm.streams.add({ name: "ORDERS-EU", subjects: ["eu.orders.>"] });
await jsm.streams.add({ name: "ORDERS-APAC", subjects: ["apac.orders.>"] });

// NATS-DOC-START
// Create ALL-ORDERS as an aggregate that sources the three regional streams
// into one. Unlike a mirror, a stream can list several sources.
const info = await jsm.streams.add({
  name: "ALL-ORDERS",
  sources: [
    { name: "ORDERS-US" },
    { name: "ORDERS-EU" },
    { name: "ORDERS-APAC" },
  ],
});
console.log(`Created ${info.config.name} sourcing ${info.config.sources?.length} streams`);
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
