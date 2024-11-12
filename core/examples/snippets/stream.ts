/*
 * Copyright 2020 The NATS Authors
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

// to create a connection to a nats-server:
const nc = await connect({ servers: "demo.nats.io" });

console.info(
  "enter the following command from your transport module to get messages from the stream",
);
console.info(
  "examples/nats-sub.ts stream.demo",
);

const start = Date.now();
let sequence = 0;
setInterval(() => {
  sequence++;
  const uptime = Date.now() - start;
  console.info(`publishing #${sequence}`);
  nc.publish("stream.demo", JSON.stringify({ sequence, uptime }));
}, 1000);
