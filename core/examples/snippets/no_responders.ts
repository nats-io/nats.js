/*
 * Copyright 2024 Synadia Communications, Inc
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

import { connect } from "jsr:@nats-io/transport-deno@3.0.0-7";
import { errors } from "jsr:@nats-io/transport-deno@3.0.0-7";

const nc = await connect(
  {
    servers: `demo.nats.io`,
  },
);

try {
  const m = await nc.request("hello.world");
  console.log(m.data);
} catch (err) {
  if (err instanceof Error) {
    if (err.cause instanceof errors.TimeoutError) {
      console.log("someone is listening but didn't respond");
    } else if (err.cause instanceof errors.NoRespondersError) {
      console.log("no one is listening to 'hello.world'");
    } else {
      console.log(
        `failed due to unknown error: ${(err.cause as Error)?.message}`,
      );
    }
  } else {
    console.log(`request failed: ${err}`);
  }
}

await nc.close();
