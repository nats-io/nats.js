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

// connect to NATS server
const nc = await connect({ servers: "localhost:4222" });

// NATS-DOC-START
// Create a wire tap for monitoring
const sub = nc.subscribe(">");
(async () => {
  for await (const msg of sub) {
    console.log(`[MONITOR] ${msg.subject}: ${msg.string()}`);
  }
})().catch(console.error);
// NATS-DOC-END

nc.publish("hello", "Hello NATS!");
nc.publish("event.new", "click");
nc.publish("weather.north.fr", "Temperature: 11°C");

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
