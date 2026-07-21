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
// Create three workers in the same queue group
async function process(label: string) {
  const sub = nc.subscribe("orders.new", { queue: "workers" });
  for await (const msg of sub) {
    console.log(`Worker ${label} processed: ${msg.string()}`);
  }
}

process("A").catch(console.error);
process("B").catch(console.error);
process("C").catch(console.error);

// Publish messages - automatically load balanced
for (let i = 1; i <= 10; i++) {
  nc.publish("orders.new", `Order ${i}`);
}
// NATS-DOC-END

await nc.flush();
await nc.drain();
