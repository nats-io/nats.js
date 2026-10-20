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

// get a JetStream manager and the current ORDERS configuration
const jsm = await jetstreamManager(nc);
const info = await jsm.streams.info("ORDERS");

// NATS-DOC-START
// Turn on direct access by setting allow_direct on the stream config and
// applying the update.
const config = info.config;
config.allow_direct = true;
const updated = await jsm.streams.update("ORDERS", config);
console.log(`allow_direct: ${updated.config.allow_direct}`);
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
