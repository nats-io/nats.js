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

// connect to NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
async function subscribeAndIterate(subject: string) {
  const sub = nc.subscribe(subject);
  const label = `[${subject}]`.padEnd(23);
  for await (const msg of sub) {
    console.log(`${label}${msg.string().padEnd(15)} (${msg.subject})`);
  }
}

// Subscribe to all alarms
subscribeAndIterate("sensor.alarm.*").catch(console.error);

// Subscribe to all critical
subscribeAndIterate("sensor.*.*.critical").catch(console.error);

// Subscribe to everything
subscribeAndIterate("sensor.>").catch(console.error);

// Publish to specific subjects
nc.publish("sensor.alarm.smoke", "kitchen,14:22");
nc.publish("sensor.alarm.smoke.critical", "kitchen,14:23");
nc.publish("sensor.alarm.water", "basement,16:42");
nc.publish("sensor.alarm.water.critical", "basement,16:43");
// NATS-DOC-END

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
