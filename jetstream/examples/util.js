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

import { nuid } from "https://esm.run/@nats-io/nats-core";
import { AckPolicy, jetstreamManager } from "https://esm.run/@nats-io/jetstream";

export async function setupStreamAndConsumer(
  nc,
  messages = 100,
) {
  const stream = nuid.next();
  const jsm = await jetstreamManager(nc);
  const js = jsm.jetstream();
  await jsm.streams.add({ name: stream, subjects: [`${stream}.*`] });
  const buf = [];
  for (let i = 0; i < messages; i++) {
    buf.push(js.publish(`${stream}.${i}`, `${i}`));
    if (buf.length % 500 === 0) {
      await Promise.all(buf);
      buf.length = 0;
    }
  }
  if (buf.length > 0) {
    await Promise.all(buf);
    buf.length = 0;
  }

  const consumer = await jsm.consumers.add(stream, {
    name: stream,
    ack_policy: AckPolicy.Explicit,
  });

  return { stream, consumer };
}
