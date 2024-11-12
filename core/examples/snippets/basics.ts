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
const nc = await connect({ servers: "demo.nats.io:4222" });

// create a simple subscriber and iterate over messages
// matching the subscription
const sub = nc.subscribe("hello");
(async () => {
  for await (const m of sub) {
    console.log(`[${sub.getProcessed()}]: ${m.string()}`);
  }
  console.log("subscription closed");
})();

nc.publish("hello", "world");
nc.publish("hello", "again");

// we want to ensure that messages that are in flight
// get processed, so we are going to drain the
// connection. Drain is the same as close, but makes
// sure that all messages in flight get seen
// by the iterator. After calling drain,
// the connection closes.
await nc.drain();
