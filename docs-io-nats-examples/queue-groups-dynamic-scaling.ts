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
import { connect, type Subscription, delay } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "localhost:4222" });

// NATS-DOC-START
// Worker that can be dynamically added/removed
function process(id: string): Promise<{id: string, sub: Subscription}> {
  const sub = nc.subscribe("tasks", { queue: "workers" });
  (async () => {
    for await (const msg of sub) {
      console.log(`Worker ${id} processing: ${msg.string()}`);
      // Simulate work
      await delay(100);
    }
  })().catch(console.error);
  return Promise.resolve({ id, sub });
}

setInterval(() => {
  nc.publish("tasks", new Date().toISOString());
}, 50)

// Dynamic scaling
const workers: { id: string, sub: Subscription }[] = [];

// Scale up
for (let i = 1; i <= 5; i++) {
  workers.push(await process(`${i}`));
}

// Scale down
await delay(1000);
const removed = workers.pop();
if (removed) {
  removed.sub.unsubscribe();
}
// NATS-DOC-END

await delay(1000);

await nc.drain();
