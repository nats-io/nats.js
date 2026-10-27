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
import { connect, createInbox } from "@nats-io/transport-deno";

const nc = await connect({ servers: "localhost:4222" });

// NATS-DOC-START
// Scatter one request to every shipping-quote provider and gather the replies.
// Subscribe to a private inbox, publish the request with that inbox as the
// reply subject, then collect quotes until they stop arriving and pick the
// cheapest.
const order =
  '{"order_id":"ord_8w2k","customer":"acme-co","total_cents":4200,"ts":"2026-05-22T10:14:22Z"}';
const inbox = createInbox();
const sub = nc.subscribe(inbox);
nc.publish("shipping.quote", order, { reply: inbox });

const quotes: string[] = [];
const gather = (async () => {
  for await (const msg of sub) {
    quotes.push(msg.string());
  }
})();

// Stop once no further reply is expected.
setTimeout(() => sub.unsubscribe(), 300);
await gather;

console.log(`gathered ${quotes.length} quotes: ${JSON.stringify(quotes)}`);
// NATS-DOC-END

await nc.drain();
