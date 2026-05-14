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
import { connect, headers } from "@nats-io/transport-deno";
import type { Subscription } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Header Aware service
const sub = nc.subscribe("service");
(async (sub: Subscription) => {
  for await (const m of sub) {
    const h = headers();
    const id = m.headers?.get("X-Request-ID");
    if (id) {
      h.append("X-Response-ID", id);
      h.append("X-Request-ID", id);
    }
    const pri = m.headers?.get("X-Priority");
    if (pri) {
      h.append("X-Priority", pri);
    }
    m.respond(m.data, {
      headers: h,
    });
  }
})(sub);

// Create message with headers
const h = headers();
h.append("X-Request-ID", "123");
h.append("X-Priority", "high");

const response = await nc.request("service", "data", {
  headers: h,
  timeout: 1000,
});
console.log(`Response: ${response.string()}`);
const responseId = response.headers?.get("X-Response-ID");
if (responseId) {
  console.log(`Response ID: ${responseId}`);
}
// NATS-DOC-END

await nc.drain();
