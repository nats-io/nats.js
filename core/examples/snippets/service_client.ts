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
import { connect, Empty } from "@nats-io/transport-deno";

// create a connection
const nc = await connect({ servers: "demo.nats.io:4222" });

// create an encoder

// the client makes a request and receives a promise for a message
// by default the request times out after 1s (1000 millis) and has
// no payload.
await nc.request("time", Empty, { timeout: 1000 })
  .then((m) => {
    console.log(`got response: ${m.string()}`);
  })
  .catch((err) => {
    console.log(`problem with request: ${err.message}`);
  });

await nc.close();
