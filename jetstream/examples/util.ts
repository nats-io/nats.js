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

import { createConsumer, fill, initStream } from "../tests/jstest_util.ts";
import type { NatsConnection } from "jsr:@nats-io/nats-core@3.0.0-17";
import { nuid } from "jsr:@nats-io/nats-core@3.0.0-17";

export async function setupStreamAndConsumer(
  nc: NatsConnection,
  messages = 100,
): Promise<{ stream: string; consumer: string }> {
  const stream = nuid.next();
  await initStream(nc, stream, { subjects: [`${stream}.*`] });
  await fill(nc, stream, messages, { randomize: true });
  const consumer = await createConsumer(nc, stream);

  return { stream, consumer };
}
