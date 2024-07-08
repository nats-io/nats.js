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
import { connect } from "jsr:@nats-io/nats-transport-deno@3.0.0-5";
import type { Subscription } from "jsr:@nats-io/nats-transport-deno@3.0.0-5";

// create a connection
const nc = await connect({ servers: "demo.nats.io:4222" });

// create a simple subscriber that listens for only one message
// and then auto unsubscribes, ending the async iterator
const sub = nc.subscribe("hello", { max: 3 });
const h1 = handler(sub);
const msub = nc.subscribe("hello");
const h2 = handler(msub);

for (let i = 1; i < 6; i++) {
  nc.publish("hello", `hello-${i}`);
}
// ensure all the messages have been delivered to the server
// meaning that the subscription also processed them.
await nc.flush();
// unsub manually from the second subscription
msub.unsubscribe();

// await the handlers come back
await Promise.all([h1, h2]);
await nc.close();

async function handler(s: Subscription) {
  const id = s.getID();
  const max = s.getMax();
  console.log(
    `sub [${id}] listening to ${s.getSubject()} ${
      max ? "and will unsubscribe after " + max + " msgs" : ""
    }`,
  );
  for await (const m of s) {
    console.log(`sub [${id}] #${s.getProcessed()}: ${m.string()}`);
  }
  console.log(`sub [${id}] is done.`);
}
