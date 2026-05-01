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

import { connect, delay, nanos, nuid } from "@nats-io/transport-deno";
import { jetstreamManager } from "@nats-io/jetstream";

const nc = await connect();
const jsm = await jetstreamManager(nc);

const name = `schedules-${nuid.next()}`;
await jsm.streams.add({
  name,
  allow_msg_schedules: true,
  subjects: [`${name}.schedule.>`, `${name}.target.>`, `${name}.stop`],
});

await jsm.consumers.add(name, {
  flow_control: true,
  idle_heartbeat: nanos(60_000),
  deliver_subject: "scheduled.message",
  filter_subject: `${name}.target.>`,
  ack_policy: "none",
});

const js = jsm.jetstream();

// every allows you to specify a duration like 1s, 1h, etc.
await js.publish(`${name}.schedule.tick`, "", {
  schedule: {
    specification: { every: "1s" },
    target: `${name}.target.tick`,
  },
});

// you can also specify a one-shot schedule - "in 10s"
await js.publish(`${name}.schedule.in10`, "", {
  schedule: {
    specification: `@at ${new Date(Date.now() + 10_000).toISOString()}`,
    target: `${name}.target.in10`,
  },
});

// or using a cron schedule - here at the 15s intervals in the minute
await js.publish(`${name}.schedule.tick15`, "", {
  schedule: {
    // 0, 15, 30, 45 seconds
    specification: { cron: "*/15 * * * * *" },
    target: `${name}.target.15`,
  },
});

// or using a predefined schedule:
// @yearly, @monthly, @weekly, @daily, @midnight, @hourly
await js.publish(`${name}.schedule.hourly`, "", {
  schedule: {
    specification: { predefined: "@hourly" },
    target: `${name}.target.hourly`,
  },
});

delay(15_000).then(() => {
  console.log("stopping every 1s tick schedule");
  js.publish(`${name}.stop`, "", {
    cancelSchedule: { scheduleSubject: `${name}.schedule.tick` },
  }).catch(console.error);
});

const sub = nc.subscribe("scheduled.message", {
  // 15s of ticks, + cron + and one shot
  max: 24,
  callback: (_err, msg) => {
    console.log(new Date().toISOString(), msg.subject.split(".").pop());
  },
});

await sub.closed;
await nc.close();
