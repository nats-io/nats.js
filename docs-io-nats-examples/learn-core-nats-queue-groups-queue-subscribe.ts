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

const nc = await connect({ servers: "localhost:4222" });

// NATS-DOC-START
// Join the "packers" queue group on orders.created. Every subscriber that
// names the same group shares the load: each order is delivered to exactly
// one member. Run this in several processes to watch the load balance.
const sub = nc.subscribe("orders.created", { queue: "packers" });
for await (const msg of sub) {
  console.log(`packer handling: ${msg.string()}`);
}
// NATS-DOC-END
