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
// Read a single message at sequence 1 through the Direct Get API. This needs
// allow_direct on the stream and can be served by any replica, not just the
// leader.
const m = await jsm.direct.getMessage("ORDERS", { seq: 1 });
console.log(`subject: ${m?.subject}`);
console.log(`payload: ${m?.string()}`);
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
