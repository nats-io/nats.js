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

import { connect } from "@nats-io/transport-deno";
import { jetstream } from "@nats-io/jetstream";
import { setupStreamAndConsumer } from "./util.js";

// create a connection
const nc = await connect({ debug: true });

// create a stream with a random name with some messages and a consumer
const { stream, consumer } = await setupStreamAndConsumer(nc);

// retrieve an existing consumer
const js = jetstream(nc);

const c = await js.consumers.get(stream, consumer);
while (true) {
  const messages = await c.consume({
    max_messages: 1,
  });

  // watch the to see if the consume operation misses heartbeats
  (async () => {
    for await (const s of messages.status()) {
      switch (s.type) {
        case "heartbeats_missed":
          console.log(`${s.count} heartbeats missed`);
          if (s.count === 2) {
            messages.stop();
          }
      }
    }
  })();

  for await (const m of messages) {
    console.log(`${m.seq} ${m?.subject}`);
    m.ack();
  }
}
