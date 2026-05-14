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

// connect to NATS demo server
const nc = await connect({ servers: "localhost:4222" });

// NATS-DOC-START
// Subscribe to the "weather.updates" subject; auto-close after 1 message
const sub = nc.subscribe("weather.updates", { max: 1, timeout: 5000 });
// NATS-DOC-END
console.log("Listening for messages on 'weather.updates'...");

// iterate over messages received
for await (const msg of sub) {
  console.log(`Received: ${msg.string()}`);
}

// drain will close the connection after processing pending messages
await nc.drain();
