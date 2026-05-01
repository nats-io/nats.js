/*
 * Copyright 2025-2026 The NATS Authors
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
import { jetstreamManager, scheduleSpecToHeader } from "../src/jsclient.ts";
import { deferred, nanos } from "@nats-io/nats-core";
import { cleanup, jetstreamServerConf, notCompatible, setup } from "nst";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";

Deno.test("schedules - basics", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.12.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "schedules",
    allow_msg_schedules: true,
    subjects: ["schedules.>", "target.>"],
    allow_msg_ttl: true,
  });

  await jsm.consumers.add("schedules", {
    flow_control: true,
    idle_heartbeat: nanos(60_000),
    deliver_subject: "cron",
    filter_subject: "target.>",
  });

  const d3000 = deferred();
  const d5000 = deferred();

  nc.subscribe("cron", {
    callback: (_, m) => {
      if (m.subject.endsWith("5000")) {
        d5000.resolve();
      } else if (m.subject.endsWith("3000")) {
        d3000.resolve();
      }
    },
  });

  const js = jsm.jetstream();

  const specification = "@at " + new Date(Date.now() + 5000).toISOString();
  await js.publish("schedules.a", "5000", {
    schedule: {
      specification,
      target: "target.5000",
      ttl: "5m",
    },
  });

  await js.publish("schedules.b", "3000", {
    schedule: {
      specification: new Date(Date.now() + 3000),
      target: "target.3000",
      ttl: "5m",
    },
  });

  await Promise.all([d3000, d5000]);

  await cleanup(ns, nc);
});

Deno.test("schedules - spec to header", () => {
  assertEquals(scheduleSpecToHeader("@every 1s"), "@every 1s");

  const d = new Date("2026-01-01T00:00:00.000Z");
  assertEquals(scheduleSpecToHeader(d), "@at 2026-01-01T00:00:00.000Z");

  assertEquals(
    scheduleSpecToHeader({ at: d }),
    "@at 2026-01-01T00:00:00.000Z",
  );
  assertEquals(
    scheduleSpecToHeader({ at: "2026-01-01T00:00:00Z" }),
    "@at 2026-01-01T00:00:00Z",
  );
  assertEquals(scheduleSpecToHeader({ every: "1s" }), "@every 1s");
  assertEquals(
    scheduleSpecToHeader({ cron: "0 0 5 * * *" }),
    "0 0 5 * * *",
  );
  assertEquals(
    scheduleSpecToHeader({ predefined: "@hourly" }),
    "@hourly",
  );

  assertThrows(
    () => scheduleSpecToHeader({ every: "500ms" }),
    Error,
    "@every interval must be at least 1s",
  );
  assertThrows(
    () => scheduleSpecToHeader({ every: "999ms" }),
    Error,
    "@every interval must be at least 1s",
  );
  assertThrows(
    () => scheduleSpecToHeader({ every: "1x" }),
    Error,
    "@every: unrecognized duration format",
  );
  assertThrows(
    () => scheduleSpecToHeader({ every: "" }),
    Error,
    "@every: unrecognized duration format",
  );
  assertEquals(scheduleSpecToHeader({ every: "1m30s" }), "@every 1m30s");
});

Deno.test("schedules - @every", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "every",
    allow_msg_schedules: true,
    subjects: ["sched.>", "tgt.>"],
    allow_msg_ttl: true,
  });

  await jsm.consumers.add("every", {
    flow_control: true,
    idle_heartbeat: nanos(60_000),
    deliver_subject: "every.deliver",
    filter_subject: "tgt.>",
  });

  const fires: number[] = [];
  const got2 = deferred<void>();
  nc.subscribe("every.deliver", {
    callback: (_, m) => {
      if (m.subject === "tgt.every") {
        fires.push(Date.now());
        if (fires.length >= 2) {
          got2.resolve();
        }
      }
    },
  });

  const js = jsm.jetstream();
  await js.publish("sched.every", "tick", {
    schedule: {
      specification: { every: "1s" },
      target: "tgt.every",
      ttl: "5m",
    },
  });

  await got2;
  // two fires roughly 1s apart
  const delta = fires[1] - fires[0];
  if (delta < 800 || delta > 2500) {
    throw new Error(`unexpected interval between fires: ${delta}ms`);
  }

  await cleanup(ns, nc);
});

Deno.test("schedules - cron every second", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "cron",
    allow_msg_schedules: true,
    subjects: ["sched.>", "tgt.>"],
    allow_msg_ttl: true,
  });

  await jsm.consumers.add("cron", {
    flow_control: true,
    idle_heartbeat: nanos(60_000),
    deliver_subject: "cron.deliver",
    filter_subject: "tgt.>",
  });

  const got = deferred<void>();
  nc.subscribe("cron.deliver", {
    callback: (_, m) => {
      if (m.subject === "tgt.cron") {
        got.resolve();
      }
    },
  });

  const js = jsm.jetstream();
  await js.publish("sched.cron", "tick", {
    schedule: {
      specification: { cron: "* * * * * *" },
      target: "tgt.cron",
      ttl: "5m",
    },
  });

  await got;
  await cleanup(ns, nc);
});

Deno.test("schedules - predefined and timezone accepted", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "predef",
    allow_msg_schedules: true,
    subjects: ["sched.>", "tgt.>"],
    allow_msg_ttl: true,
  });

  const js = jsm.jetstream();

  // server should accept @hourly + tz; we don't wait an hour.
  await js.publish("sched.hourly", "tick", {
    schedule: {
      specification: { predefined: "@hourly" },
      target: "tgt.hourly",
      timezone: "America/Denver",
      ttl: "5m",
    },
  });

  // accepted = no error from publish
  await cleanup(ns, nc);
});

Deno.test("schedules - cancel schedule", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "cancel",
    allow_msg_schedules: true,
    subjects: ["sched.>", "tgt.>", "stop.>"],
    allow_msg_ttl: true,
  });

  await jsm.consumers.add("cancel", {
    flow_control: true,
    idle_heartbeat: nanos(60_000),
    deliver_subject: "cancel.deliver",
    filter_subject: "stop.>",
  });

  const got = deferred<void>();
  nc.subscribe("cancel.deliver", {
    callback: (_, m) => {
      if (m.subject === "stop.canceled") {
        got.resolve();
      }
    },
  });

  const js = jsm.jetstream();

  // schedule fires every second into tgt.cancelled
  await js.publish("sched.cancel", "tick", {
    schedule: {
      specification: { every: "1s" },
      target: "tgt.cancelled",
      ttl: "5m",
    },
  });

  // atomic cancel: publish to stop.canceled and remove the schedule
  await js.publish("stop.canceled", "stopped", {
    cancelSchedule: { scheduleSubject: "sched.cancel" },
  });

  await got;

  await cleanup(ns, nc);
});

Deno.test("schedules - cancel rejects same subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "cancel2",
    allow_msg_schedules: true,
    subjects: ["sched.>"],
  });

  const js = jsm.jetstream();
  await assertRejects(
    () =>
      js.publish("sched.x", "", {
        cancelSchedule: { scheduleSubject: "sched.x" },
      }),
    Error,
    "cancelSchedule.scheduleSubject must not equal the publish subject",
  );

  await cleanup(ns, nc);
});

Deno.test("schedules - schedule and cancelSchedule mutually exclusive", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "mutex",
    allow_msg_schedules: true,
    subjects: ["sched.>"],
  });

  const js = jsm.jetstream();
  await assertRejects(
    () =>
      js.publish("sched.x", "", {
        schedule: {
          specification: { every: "1s" },
          target: "tgt.x",
        },
        cancelSchedule: { scheduleSubject: "sched.y" },
      }),
    Error,
    "schedule and cancelSchedule are mutually exclusive",
  );

  await cleanup(ns, nc);
});

Deno.test("schedules - rollup header", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.14.0")) {
    await cleanup(ns, nc);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "rollup",
    allow_msg_schedules: true,
    subjects: ["sched.>", "tgt.>"],
    allow_msg_ttl: true,
    allow_rollup_hdrs: true,
  });

  const js = jsm.jetstream();
  await js.publish("sched.rollup", "tick", {
    schedule: {
      specification: { every: "1s" },
      target: "tgt.rollup",
      rollup: "sub",
      ttl: "5m",
    },
  });

  await cleanup(ns, nc);
});
