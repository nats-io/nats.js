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
// Service instance with queue group for load balancing
function createServiceInstance(instanceId: string) {
  const sub = nc.subscribe("api.calculate", { queue: "api-workers" });
  (async () => {
    for await (const msg of sub) {
      const data = msg.string().split(",");
      const result = parseInt(data[0], 10) + parseInt(data[1], 10);
      const response =
        `Result: ${result}, processed by: instance-${instanceId}`;
      msg.respond(response);
      console.log(`Instance ${instanceId} processed request`);
    }
  })().catch(console.error);
}

// Start multiple service instances
for (let i = 1; i <= 3; i++) {
  createServiceInstance(`instance-${i}`);
}

// Make requests - automatically load balanced
for (let i = 0; i < 10; i++) {
  try {
    const response = await nc.request("api.calculate", `${i},${i * 2}`, {
      timeout: 1000,
    });
    console.log(`Response: ${response.string()}`);
  } catch (e) {
    console.error(`Request failed: ${(e as Error).message}`);
  }
}
// NATS-DOC-END

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
