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
  // required to use ttl on schedules - fired messages get Nats-TTL
  // and auto-purge so the stream doesn't grow unbounded
  allow_msg_ttl: true,
  // schedule holds the config portion for a schedule
  // target the destination message added to the stream by the schedule
  // stop to cancel scheduling a specific schedule
  // data the subject to copy value from the last message (optional)
  subjects: [
    `${name}.schedule.>`,
    `${name}.target.>`,
    `${name}.stop`,
    `${name}.data.*`,
  ],
  max_msgs_per_subject: 10,
});

await jsm.consumers.add(name, {
  flow_control: true,
  idle_heartbeat: nanos(60_000),
  deliver_subject: "scheduled.message",
  filter_subject: `${name}.target.>`,
  ack_policy: "none",
});

const js = jsm.jetstream();

// update a value every 100ms
const stocks = ["ABC", "XYZ", "BRB", "ZON"];
await Promise.all([
  js.publish(`${name}.data.ABC`, `0`),
  js.publish(`${name}.data.XYZ`, `0`),
  js.publish(`${name}.data.BRB`, `0`),
  js.publish(`${name}.data.ZON`, `0`),
]);

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const timer = setInterval(() => {
  const symbol = pick(stocks);
  const price = `${Math.floor(Math.random() * 101)}`;
  js.publish(`${name}.data.${symbol}`, price).catch(console.error);
}, 100);

// every allows you to specify a duration like 1s, 1h, etc.
// ttl puts a Nats-TTL on each fired message so they auto-purge
await js.publish(`${name}.schedule.ABC`, "", {
  schedule: {
    specification: { every: "1s" },
    target: `${name}.target.ABC`,
    // payload will be the last message in `${name}.data`
    source: `${name}.data.ABC`,
    ttl: "5s",
  },
});

// you can also specify a one-shot schedule - "in 10s"
await js.publish(`${name}.schedule.XYZ`, "", {
  schedule: {
    specification: `@at ${new Date(Date.now() + 10_000).toISOString()}`,
    target: `${name}.target.XYZ`,
    source: `${name}.data.XYZ`,
    ttl: "5s",
  },
});

// or using a cron schedule - here at the 15s intervals in the minute
await js.publish(`${name}.schedule.BRB`, "", {
  schedule: {
    // 0, 15, 30, 45 seconds
    specification: { cron: "*/15 * * * * *" },
    target: `${name}.target.BRB`,
    source: `${name}.data.BRB`,
    ttl: "5s",
  },
});

// or using a predefined schedule:
// @yearly, @monthly, @weekly, @daily, @midnight, @hourly
await js.publish(`${name}.schedule.hourly`, "", {
  schedule: {
    specification: { predefined: "@hourly" },
    target: `${name}.target.hourly`,
    source: `${name}.data.ZON`,
    ttl: "5s",
  },
});

delay(15_000).then(() => {
  console.log("stopping ABC schedule");
  js.publish(`${name}.stop`, "", {
    cancelSchedule: { scheduleSubject: `${name}.schedule.ABC` },
  }).catch(console.error);
});

const sub = nc.subscribe("scheduled.message", {
  // 18 updates and stop
  max: 18,
  callback: (_err, msg) => {
    console.log(
      new Date().toLocaleTimeString(),
      msg.subject.split(".").pop(),
      msg.string(),
    );
  },
});

await sub.closed;
await nc.close();
clearInterval(timer);
