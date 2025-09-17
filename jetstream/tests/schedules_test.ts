/*
 * Copyright 2025 The NATS Authors
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
import { jetstreamManager } from "../src/jsclient.ts";
import { deferred, nanos } from "@nats-io/nats-core";
import {
  cleanup,
  jetstreamServerConf,
  notCompatible,
  setup,
} from "test_helpers";

Deno.test("schedules - basics", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.11.0")) {
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
