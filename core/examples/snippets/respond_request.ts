/*
 * Copyright 2026 Synadia Communications, Inc
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

import { connect, createInbox } from "@nats-io/transport-deno";

const nc = await connect({ servers: "demo.nats.io" });

// the worker hands out a job and waits for the requester to confirm it
const sub = nc.subscribe("jobs", { max: 1 });
const worker = (async () => {
  for await (const m of sub) {
    try {
      const r = await m.respondRequest("job-42", { timeout: 5000 });
      console.log(`requester confirmed: ${r.string()}`);
    } catch (err) {
      // timeout or no responders - the job wasn't taken, hand it out again
      console.log(`job not confirmed: ${(err as Error).message}`);
    }
  }
})();

// the requester gets the job, itself a request, and confirms it
const inbox = createInbox();
nc.subscribe(inbox, {
  max: 1,
  callback: (_err, m) => {
    console.log(`got ${m.string()}`);
    m.respond("ok");
  },
});
nc.publish("jobs", "", { reply: inbox });

await worker;
await nc.close();
