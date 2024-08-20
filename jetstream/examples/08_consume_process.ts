/*
 * Copyright 2023 The NATS Authors
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

import { connect } from "jsr:@nats-io/nats-transport-deno@3.0.0-5";
import { setupStreamAndConsumer } from "./util.ts";
import { jetstream } from "../src/mod.ts";

// create a connection
const nc = await connect();

// create a stream with a random name with some messages and a consumer
const { stream, consumer } = await setupStreamAndConsumer(nc, 10000);

// retrieve an existing consumer
const js = jetstream(nc);
const c = await js.consumers.get(stream, consumer);

// this example uses a consume that processes the stream
// creating a frequency table based on the subjects found
const messages = await c.consume();

const data = new Map<string, number>();
for await (const m of messages) {
  const chunks = m.subject.split(".");
  const v = data.get(chunks[1]) || 0;
  data.set(chunks[1], v + 1);
  m.ack();

  // if no pending, then we have processed the stream
  // and we can break
  if (m.info.pending === 0) {
    break;
  }
}

// we can safely delete the consumer
await c.delete();

const keys = [];
for (const k of data.keys()) {
  keys.push(k);
}
keys.sort();
keys.forEach((k) => {
  console.log(`${k}: ${data.get(k)}`);
});

await nc.close();
