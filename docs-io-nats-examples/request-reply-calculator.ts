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
import type { Subscription } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "localhost:4222" });

// NATS-DOC-START
// Calculator service
const sub = nc.subscribe("calc.add");
(async (sub: Subscription) => {
  for await (const m of sub) {
    try {
      const {a, b} = m.json<{ a: number, b: number }>();
      if (typeof a !== "number" || typeof b !== "number") {
        throw new Error("invalid input");
      }
      m.respond(JSON.stringify({result: a+b}))
    } catch(err) {
      m.respond("error: invalid input");
    }
  }
})(sub).catch(console.error);

// Make calculations
let resp = await nc.request("calc.add", JSON.stringify({a: 5, b: 3}));
console.log(`5 + 3 = ${resp.string()}`);

resp = await nc.request("calc.add", JSON.stringify({a: 10, b: 7}));
console.log(`10 + 7 = ${resp.string()}`);

resp = await nc.request("calc.add", JSON.stringify({a: 10, b: "x"}));
console.log(`10 + x = ${resp.string()}`);
// NATS-DOC-END

await nc.flush();
await nc.drain();
