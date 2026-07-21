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
import { connect, RequestError, TimeoutError } from "@nats-io/transport-deno";

const nc = await connect({ servers: "localhost:4222" });

// NATS-DOC-START
// Ask the inventory service whether an order's item is in stock. The client
// creates a private inbox, sends the request, and waits up to the timeout for
// one reply. A missing service surfaces immediately as NoRespondersError; a
// slow one as TimeoutError.
const order =
  '{"order_id":"ord_8w2k","customer":"acme-co","total_cents":4200,"ts":"2026-05-22T10:14:22Z"}';
try {
  const reply = await nc.request("orders.inventory.check", order, {
    timeout: 2000,
  });
  console.log(`inventory replied: ${reply.string()}`);
} catch (err) {
  if (err instanceof RequestError && err.isNoResponders()) {
    console.log("no inventory service is running");
  } else if (err instanceof TimeoutError) {
    console.log("inventory service did not answer in time");
  } else {
    throw err;
  }
}
// NATS-DOC-END

await nc.drain();
