/*
 * Copyright 2021-2024 The NATS Authors
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
import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
  fail,
} from "jsr:@std/assert";

import type { NatsConnectionImpl } from "@nats-io/nats-core/internal";
import { Feature } from "@nats-io/nats-core/internal";
import type { NatsConnection } from "@nats-io/nats-core";
import {
  deferred,
  Empty,
  errors,
  headers,
  InvalidArgumentError,
  jwtAuthenticator,
  nanos,
  nkeys,
  nuid,
} from "@nats-io/nats-core";
import type {
  ConsumerConfig,
  ConsumerInfo,
  Lister,
  PubAck,
  StreamConfig,
  StreamInfo,
  StreamSource,
} from "../src/mod.ts";
import {
  AckPolicy,
  AdvisoryKind,
  DiscardPolicy,
  jetstream,
  jetstreamManager,
  StorageType,
} from "../src/mod.ts";
import { initStream } from "./jstest_util.ts";
import {
  cleanup,
  connect,
  flakyTest,
  jetstreamExportServerConf,
  jetstreamServerConf,
  NatsServer,
  notCompatible,
  setup,
} from "test_helpers";
import { validateName } from "../src/jsutil.ts";
import {
  encodeAccount,
  encodeOperator,
  encodeUser,
} from "jsr:@nats-io/jwt@0.0.9-3";
import { convertStreamSourceDomain } from "../src/jsmstream_api.ts";
import type { ConsumerAPIImpl } from "../src/jsmconsumer_api.ts";
import {
  ConsumerApiAction,
  PriorityPolicy,
  StoreCompression,
} from "../src/jsapi_types.ts";
import type { JetStreamManagerImpl } from "../src/jsclient.ts";
import { stripNatsMetadata } from "./util.ts";
import { jserrors } from "../src/jserrors.ts";
import type { WithRequired } from "../../core/src/util.ts";

const StreamNameRequired = "stream name required";
const ConsumerNameRequired = "durable name required";

Deno.test("jsm - jetstream not enabled", async () => {
  // start a regular server - no js conf
  const { ns, nc } = await setup();
  await assertRejects(
    () => {
      return jetstreamManager(nc);
    },
    jserrors.JetStreamNotEnabled,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - account info", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const ai = await jsm.getAccountInfo();
  assert(ai.limits.max_memory === -1 || ai.limits.max_memory > 0);
  await cleanup(ns, nc);
});

Deno.test("jsm - account not enabled", async () => {
  const conf = {
    "no_auth_user": "b",
    accounts: {
      A: {
        jetstream: "enabled",
        users: [{ user: "a", password: "a" }],
      },
      B: {
        users: [{ user: "b" }],
      },
    },
  };
  const { ns, nc } = await setup(jetstreamServerConf(conf));
  await assertRejects(
    () => {
      return jetstreamManager(nc);
    },
    jserrors.JetStreamNotEnabled,
  );

  const a = await connect(
    { port: ns.port, user: "a", pass: "a" },
  );
  await jetstreamManager(a);
  await a.close();
  await cleanup(ns, nc);
});

Deno.test("jsm - empty stream config fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    async () => {
      await jsm.streams.add({} as StreamConfig);
    },
    Error,
    StreamNameRequired,
    undefined,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - empty stream config update fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  let ci = await jsm.streams.add({ name: name, subjects: [`${name}.>`] });
  assertEquals(ci!.config!.subjects!.length, 1);

  await assertRejects(
    async () => {
      await jsm.streams.update("", {} as StreamConfig);
    },
    Error,
    StreamNameRequired,
    undefined,
  );
  ci!.config!.subjects!.push("foo");
  ci = await jsm.streams.update(name, ci.config);
  assertEquals(ci!.config!.subjects!.length, 2);
  await cleanup(ns, nc);
});

Deno.test("jsm - update stream name is internally added", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  const ci = await jsm.streams.add({
    name: name,
    subjects: [`${name}.>`],
  });
  assertEquals(ci!.config!.subjects!.length, 1);

  const si = await jsm.streams.update(name, { subjects: [`${name}.>`, "foo"] });
  assertEquals(si!.config!.subjects!.length, 2);
  await cleanup(ns, nc);
});

Deno.test("jsm - delete empty stream name fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    async () => {
      await jsm.streams.delete("");
    },
    Error,
    StreamNameRequired,
    undefined,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - info empty stream name fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    async () => {
      await jsm.streams.info("");
    },
    Error,
    StreamNameRequired,
    undefined,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - info msg not found stream name fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  await assertRejects(
    async () => {
      await jsm.streams.info(name);
    },
    jserrors.StreamNotFoundError,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - delete msg empty stream name fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    async () => {
      await jsm.streams.deleteMessage("", 1);
    },
    Error,
    StreamNameRequired,
    undefined,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - delete msg not found stream name fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  await assertRejects(
    async () => {
      await jsm.streams.deleteMessage(name, 1);
    },
    jserrors.StreamNotFoundError,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - no stream lister is empty", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const streams = await jsm.streams.list().next();
  assertEquals(streams.length, 0);
  await cleanup(ns, nc);
});

Deno.test("jsm - stream names is empty", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const names = await jsm.streams.names().next();
  assertEquals(names.length, 0);
  await cleanup(ns, nc);
});

Deno.test("jsm - lister after empty, empty", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const lister = jsm.streams.list();
  let streams = await lister.next();
  assertEquals(streams.length, 0);
  streams = await lister.next();
  assertEquals(streams.length, 0);
  await cleanup(ns, nc);
});

Deno.test("jsm - add stream", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  let si = await jsm.streams.add({ name });

  assertEquals(si.config.name, name);

  const fn = (i: StreamInfo): boolean => {
    stripNatsMetadata(si.config.metadata);
    stripNatsMetadata(i.config.metadata);

    assertEquals(i.config, si.config);
    assertEquals(i.state, si.state);
    assertEquals(i.created, si.created);
    return true;
  };

  fn(await jsm.streams.info(name));
  let lister = await jsm.streams.list().next();
  fn(lister[0]);

  // add some data
  await jetstream(nc).publish(name, Empty);
  si = await jsm.streams.info(name);
  lister = await jsm.streams.list().next();
  fn(lister[0]);

  await cleanup(ns, nc);
});

Deno.test("jsm - purge not found stream name fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  await assertRejects(
    async () => {
      await jsm.streams.purge(name);
    },
    jserrors.StreamNotFoundError,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - purge empty stream name fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    async () => {
      await jsm.streams.purge("");
    },
    Error,
    StreamNameRequired,
    undefined,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - stream purge", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  await jetstream(nc).publish(subj, Empty);

  let si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 1);

  await jsm.streams.purge(stream);
  si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 0);

  await cleanup(ns, nc);
});

Deno.test("jsm - purge by sequence", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  await jsm.streams.add(
    { name: stream, subjects: [`${stream}.*`] },
  );

  const js = jetstream(nc);
  await Promise.all([
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
  ]);

  const pi = await jsm.streams.purge(stream, { seq: 4 });
  assertEquals(pi.purged, 3);
  const si = await jsm.streams.info(stream);
  assertEquals(si.state.first_seq, 4);

  await cleanup(ns, nc);
});

Deno.test("jsm - purge by filtered sequence", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  await jsm.streams.add(
    { name: stream, subjects: [`${stream}.*`] },
  );

  const js = jetstream(nc);
  await Promise.all([
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
  ]);

  const pi = await jsm.streams.purge(stream, { seq: 4, filter: `${stream}.b` });
  assertEquals(pi.purged, 1);
  const si = await jsm.streams.info(stream);
  assertEquals(si.state.first_seq, 1);
  assertEquals(si.state.messages, 8);

  await cleanup(ns, nc);
});

Deno.test("jsm - purge by subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  await jsm.streams.add(
    { name: stream, subjects: [`${stream}.*`] },
  );

  const js = jetstream(nc);
  await Promise.all([
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
  ]);

  const pi = await jsm.streams.purge(stream, { filter: `${stream}.b` });
  assertEquals(pi.purged, 3);
  const si = await jsm.streams.info(stream);
  assertEquals(si.state.first_seq, 1);
  assertEquals(si.state.messages, 6);

  await cleanup(ns, nc);
});

Deno.test("jsm - purge by subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  await jsm.streams.add(
    { name: stream, subjects: [`${stream}.*`] },
  );

  const js = jetstream(nc);
  await Promise.all([
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
  ]);

  const pi = await jsm.streams.purge(stream, { filter: `${stream}.b` });
  assertEquals(pi.purged, 3);
  const si = await jsm.streams.info(stream);
  assertEquals(si.state.first_seq, 1);
  assertEquals(si.state.messages, 6);

  await cleanup(ns, nc);
});

Deno.test("jsm - purge keep", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  await jsm.streams.add(
    { name: stream, subjects: [`${stream}.*`] },
  );

  const js = jetstream(nc);

  await Promise.all([
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
  ]);

  const pi = await jsm.streams.purge(stream, { keep: 1 });
  assertEquals(pi.purged, 8);
  const si = await jsm.streams.info(stream);
  assertEquals(si.state.first_seq, 9);
  assertEquals(si.state.messages, 1);

  await cleanup(ns, nc);
});

Deno.test("jsm - purge filtered keep", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  await jsm.streams.add(
    { name: stream, subjects: [`${stream}.*`] },
  );

  const js = jetstream(nc);
  await Promise.all([
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
    js.publish(`${stream}.a`),
    js.publish(`${stream}.b`),
    js.publish(`${stream}.c`),
  ]);

  let pi = await jsm.streams.purge(stream, { keep: 1, filter: `${stream}.a` });
  assertEquals(pi.purged, 2);
  pi = await jsm.streams.purge(stream, { keep: 1, filter: `${stream}.b` });
  assertEquals(pi.purged, 2);
  pi = await jsm.streams.purge(stream, { keep: 1, filter: `${stream}.c` });
  assertEquals(pi.purged, 2);

  const si = await jsm.streams.info(stream);
  assertEquals(si.state.first_seq, 7);
  assertEquals(si.state.messages, 3);

  await cleanup(ns, nc);
});

Deno.test("jsm - purge seq and keep fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    () => {
      return jsm.streams.purge("a", { keep: 10, seq: 5 });
    },
    Error,
    "'keep','seq' are mutually exclusive",
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - stream delete", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  await jetstream(nc).publish(subj, Empty);
  await jsm.streams.delete(stream);
  await assertRejects(
    async () => {
      await jsm.streams.info(stream);
    },
    jserrors.StreamNotFoundError,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - stream delete message", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  await jetstream(nc).publish(subj, Empty);

  let si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 1);
  assertEquals(si.state.first_seq, 1);
  assertEquals(si.state.last_seq, 1);

  assert(await jsm.streams.deleteMessage(stream, 1));
  si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 0);
  assertEquals(si.state.first_seq, 2);
  assertEquals(si.state.last_seq, 1);

  await cleanup(ns, nc);
});

Deno.test("jsm - stream delete info", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const { stream, subj } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  const js = jetstream(nc);
  await js.publish(subj);
  await js.publish(subj);
  await js.publish(subj);
  await jsm.streams.deleteMessage(stream, 2);

  const si = await jsm.streams.info(stream, { deleted_details: true });
  assertEquals(si.state.num_deleted, 1);
  assertEquals(si.state.deleted, [2]);

  await cleanup(ns, nc);
});

Deno.test("jsm - consumer info on empty stream name fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    async () => {
      await jsm.consumers.info("", "");
    },
    Error,
    StreamNameRequired,
    undefined,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - consumer info on empty consumer name fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    async () => {
      await jsm.consumers.info("foo", "");
    },
    Error,
    ConsumerNameRequired,
    undefined,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - consumer info on not found stream fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    async () => {
      await jsm.consumers.info("foo", "dur");
    },
    jserrors.StreamNotFoundError,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - consumer info on not found consumer", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    async () => {
      await jsm.consumers.info(stream, "dur");
    },
    jserrors.ConsumerNotFoundError,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - consumer info", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(
    stream,
    { durable_name: "dur", ack_policy: AckPolicy.Explicit },
  );
  const ci = await jsm.consumers.info(stream, "dur");
  assertEquals(ci.name, "dur");
  assertEquals(ci.config.durable_name, "dur");
  assertEquals(ci.config.ack_policy, "explicit");
  await cleanup(ns, nc);
});

Deno.test("jsm - no consumer lister with empty stream fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  assertThrows(
    () => {
      jsm.consumers.list("");
    },
    Error,
    StreamNameRequired,
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - no consumer lister with no consumers empty", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  const consumers = await jsm.consumers.list(stream).next();
  assertEquals(consumers.length, 0);
  await cleanup(ns, nc);
});

Deno.test("jsm - lister", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(
    stream,
    { durable_name: "dur", ack_policy: AckPolicy.Explicit },
  );
  let consumers = await jsm.consumers.list(stream).next();
  assertEquals(consumers.length, 1);
  assertEquals(consumers[0].config.durable_name, "dur");

  await jsm.consumers.delete(stream, "dur");
  consumers = await jsm.consumers.list(stream).next();
  assertEquals(consumers.length, 0);

  await cleanup(ns, nc);
});

Deno.test("jsm - update stream", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  let si = await jsm.streams.info(stream);
  assertEquals(si.config!.subjects!.length, 1);

  si.config!.subjects!.push("foo");
  si = await jsm.streams.update(stream, si.config);
  assertEquals(si.config!.subjects!.length, 2);
  await cleanup(ns, nc);
});

Deno.test("jsm - get message", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const h = headers();
  h.set("xxx", "a");

  const js = jetstream(nc);
  await js.publish(subj, JSON.stringify(1), { headers: h });
  await js.publish(subj, JSON.stringify(2));

  const jsm = await jetstreamManager(nc);
  let sm = await jsm.streams.getMessage(stream, { seq: 1 });
  assertExists(sm);
  assertEquals(sm.subject, subj);
  assertEquals(sm.seq, 1);
  assertEquals(sm.json<number>(), 1);

  sm = await jsm.streams.getMessage(stream, { seq: 2 });
  assertExists(sm);
  assertEquals(sm.subject, subj);
  assertEquals(sm.seq, 2);
  assertEquals(sm.json<number>(), 2);

  assertEquals(await jsm.streams.getMessage(stream, { seq: 3 }), null);

  await cleanup(ns, nc);
});

Deno.test("jsm - get message (not found)", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });
  await jsm.streams.getMessage("A", { last_by_subj: "a" });
  await cleanup(ns, nc);
});

Deno.test("jsm - get message payload", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);
  const js = jetstream(nc);
  await js.publish(subj, Empty, { msgID: "empty" });
  await js.publish(subj, "", { msgID: "empty2" });

  const jsm = await jetstreamManager(nc);
  let sm = await jsm.streams.getMessage(stream, { seq: 1 });
  assertExists(sm);
  assertEquals(sm.subject, subj);
  assertEquals(sm.seq, 1);
  assertEquals(sm.data, Empty);

  sm = await jsm.streams.getMessage(stream, { seq: 2 });
  assertExists(sm);
  assertEquals(sm.subject, subj);
  assertEquals(sm.seq, 2);
  assertEquals(sm.data, Empty);
  assertEquals(sm.string(), "");

  await cleanup(ns, nc);
});

Deno.test("jsm - advisories", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  const iter = jsm.advisories();
  const streamAction = deferred();
  (async () => {
    for await (const a of iter) {
      if (a.kind === AdvisoryKind.StreamAction) {
        streamAction.resolve();
      }
    }
  })().then();
  await initStream(nc);
  await streamAction;
  await cleanup(ns, nc);
});

Deno.test("jsm - validate name", () => {
  type t = [string, boolean];
  const tests: t[] = [
    ["", false],
    [".", false],
    ["*", false],
    [">", false],
    ["hello.", false],
    ["hello.*", false],
    ["hello.>", false],
    ["one.two", false],
    ["one*two", false],
    ["one>two", false],
    ["stream", true],
  ];

  tests.forEach((v, idx) => {
    try {
      validateName(`${idx}`, v[0]);
      if (!v[1]) {
        fail(`${v[0]} should have been rejected`);
      }
    } catch (_err) {
      if (v[1]) {
        fail(`${v[0]} should have been valid`);
      }
    }
  });
});

Deno.test("jsm - minValidation", () => {
  type t = [string, boolean];
  const tests: t[] = [
    ["", false],
    [".", false],
    ["*", false],
    [">", false],
    ["hello.", false],
    ["hello\r", false],
    ["hello\n", false],
    ["hello\t", false],
    ["hello ", false],
    ["hello.*", false],
    ["hello.>", false],
    ["one.two", false],
    ["one*two", false],
    ["one>two", false],
    ["stream", true],
  ];

  tests.forEach((v, idx) => {
    try {
      validateName(`${idx}`, v[0]);
      if (!v[1]) {
        fail(`${v[0]} should have been rejected`);
      }
    } catch (_err) {
      if (v[1]) {
        fail(`${v[0]} should have been valid`);
      }
    }
  });
});

Deno.test("jsm - cross account streams", async () => {
  const { ns, nc } = await setup(jetstreamExportServerConf(), {
    user: "a",
    pass: "s3cret",
  });

  const sawIPA = deferred();
  nc.subscribe("IPA.>", {
    callback: () => {
      sawIPA.resolve();
    },
    max: 1,
  });

  const jsm = await jetstreamManager(nc, { apiPrefix: "IPA" });
  await sawIPA;

  // no streams
  let streams = await jsm.streams.list().next();
  assertEquals(streams.length, 0);

  // add a stream
  const stream = nuid.next();
  const subj = `${stream}.A`;
  await jsm.streams.add({ name: stream, subjects: [subj] });

  // list the stream
  streams = await jsm.streams.list().next();
  assertEquals(streams.length, 1);

  // cannot publish to the stream from the client account
  // publish from the js account
  const admin = await connect({ port: ns.port, user: "js", pass: "js" });
  admin.publish(subj);
  admin.publish(subj);
  await admin.flush();

  // info
  let si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 2);

  // get message
  const sm = await jsm.streams.getMessage(stream, { seq: 1 });
  assertEquals(sm?.seq, 1);

  // delete message
  let ok = await jsm.streams.deleteMessage(stream, 1);
  assertEquals(ok, true);
  si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 1);

  // purge
  const pr = await jsm.streams.purge(stream);
  assertEquals(pr.success, true);
  assertEquals(pr.purged, 1);
  si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 0);

  // update
  const config = streams[0].config as StreamConfig;
  config.subjects!.push(`${stream}.B`);
  si = await jsm.streams.update(config.name, config);
  assertEquals(si.config.subjects!.length, 2);

  // find
  const sn = await jsm.streams.find(`${stream}.B`);
  assertEquals(sn, stream);

  // delete
  ok = await jsm.streams.delete(stream);
  assertEquals(ok, true);

  streams = await jsm.streams.list().next();
  assertEquals(streams.length, 0);

  await cleanup(ns, nc, admin);
});

Deno.test(
  "jsm - cross account consumers",
  flakyTest(async () => {
    const { ns, nc } = await setup(jetstreamExportServerConf(), {
      user: "a",
      pass: "s3cret",
    });

    const sawIPA = deferred();
    nc.subscribe("IPA.>", {
      callback: () => {
        sawIPA.resolve();
      },
      max: 1,
    });

    const jsm = await jetstreamManager(nc, { apiPrefix: "IPA" });
    await sawIPA;

    // add a stream
    const stream = nuid.next();
    const subj = `${stream}.A`;
    await jsm.streams.add({ name: stream, subjects: [subj] });

    let consumers = await jsm.consumers.list(stream).next();
    assertEquals(consumers.length, 0);

    await jsm.consumers.add(stream, {
      durable_name: "me",
      ack_policy: AckPolicy.Explicit,
    });

    // cannot publish to the stream from the client account
    // publish from the js account
    const admin = await connect({ port: ns.port, user: "js", pass: "js" });
    admin.publish(subj);
    admin.publish(subj);
    await admin.flush();

    consumers = await jsm.consumers.list(stream).next();
    assertEquals(consumers.length, 1);
    assertEquals(consumers[0].name, "me");
    assertEquals(consumers[0].config.durable_name, "me");
    assertEquals(consumers[0].num_pending, 2);

    const ci = await jsm.consumers.info(stream, "me");
    assertEquals(ci.name, "me");
    assertEquals(ci.config.durable_name, "me");
    assertEquals(ci.num_pending, 2);

    const ok = await jsm.consumers.delete(stream, "me");
    assertEquals(ok, true);

    await assertRejects(
      async () => {
        await jsm.consumers.info(stream, "me");
      },
      Error,
      "consumer not found",
      undefined,
    );

    await cleanup(ns, nc, admin);
  }),
);

Deno.test("jsm - jetstream error info", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);
  await assertRejects(
    () => {
      return jsm.streams.add(
        {
          name: "a",
          num_replicas: 3,
          subjects: ["a.>"],
        },
      );
    },
    jserrors.JetStreamApiError,
    "replicas > 1 not supported in non-clustered mode",
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - update consumer", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.4")) {
    return;
  }
  const { stream } = await initStream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "dur",
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(2000),
    max_ack_pending: 500,
    headers_only: false,
    max_deliver: 100,
  });

  // update is simply syntatic sugar for add providing a type to
  // help the IDE show editable properties - server will still
  // reject options it doesn't deem editable
  const ci = await jsm.consumers.update(stream, "dur", {
    ack_wait: nanos(3000),
    max_ack_pending: 5,
    headers_only: true,
    max_deliver: 2,
  });

  assertEquals(ci.config.ack_wait, nanos(3000));
  assertEquals(ci.config.max_ack_pending, 5);
  assertEquals(ci.config.headers_only, true);
  assertEquals(ci.config.max_deliver, 2);

  await cleanup(ns, nc);
});

Deno.test("jsm - stream info subjects", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.7.2")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  await jsm.streams.add({ name, subjects: [`${name}.>`] });

  const js = jetstream(nc);
  await js.publish(`${name}.a`);
  await js.publish(`${name}.a.b`);
  await js.publish(`${name}.a.b.c`);

  let si = await jsm.streams.info(name, { subjects_filter: `>` });
  assertEquals(si.state.num_subjects, 3);
  assert(si.state.subjects);
  assertEquals(Object.keys(si.state.subjects).length, 3);
  assertEquals(si.state.subjects[`${name}.a`], 1);
  assertEquals(si.state.subjects[`${name}.a.b`], 1);
  assertEquals(si.state.subjects[`${name}.a.b.c`], 1);

  si = await jsm.streams.info(name, { subjects_filter: `${name}.a.>` });
  assertEquals(si.state.num_subjects, 3);
  assert(si.state.subjects);
  assertEquals(Object.keys(si.state.subjects).length, 2);
  assertEquals(si.state.subjects[`${name}.a.b`], 1);
  assertEquals(si.state.subjects[`${name}.a.b.c`], 1);

  si = await jsm.streams.info(name);
  assertEquals(si.state.subjects, undefined);

  await cleanup(ns, nc);
});

Deno.test("jsm - account limits", async () => {
  const O = nkeys.createOperator();
  const SYS = nkeys.createAccount();
  const A = nkeys.createAccount();

  const resolver: Record<string, string> = {};
  resolver[A.getPublicKey()] = await encodeAccount("A", A, {
    limits: {
      conn: -1,
      subs: -1,
      tiered_limits: {
        R1: {
          disk_storage: 1024 * 1024,
          consumer: -1,
          streams: -1,
        },
      },
    },
  }, { signer: O });
  resolver[SYS.getPublicKey()] = await encodeAccount("SYS", SYS, {
    limits: {
      conn: -1,
      subs: -1,
    },
  }, { signer: O });

  const conf = {
    operator: await encodeOperator("O", O, {
      system_account: SYS.getPublicKey(),
    }),
    resolver: "MEMORY",
    "resolver_preload": resolver,
  };

  const ns = await NatsServer.start(jetstreamServerConf(conf));

  const U = nkeys.createUser();
  const ujwt = await encodeUser("U", U, A, { bearer_token: true });

  const nc = await connect({
    port: ns.port,
    maxReconnectAttempts: -1,
    authenticator: jwtAuthenticator(ujwt),
  });

  const jsm = await jetstreamManager(nc);

  const ai = await jsm.getAccountInfo();
  assertEquals(ai.tiers?.R1?.limits.max_storage, 1024 * 1024);
  assertEquals(ai.tiers?.R1?.limits.max_consumers, -1);
  assertEquals(ai.tiers?.R1?.limits.max_streams, -1);
  assertEquals(ai.tiers?.R1?.limits.max_ack_pending, -1);

  await cleanup(ns, nc);
});

Deno.test("jsm - stream update preserves other value", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({
    name: "a",
    storage: StorageType.File,
    discard: DiscardPolicy.New,
    subjects: ["x"],
  });

  const si = await jsm.streams.update("a", { subjects: ["x", "y"] });
  assertEquals(si.config.discard, DiscardPolicy.New);
  assertEquals(si.config.subjects, ["x", "y"]);

  await cleanup(ns, nc);
});

Deno.test("jsm - consumer name", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "A",
    subjects: ["foo", "bar"],
  });

  async function addC(
    config: Partial<ConsumerConfig>,
    expect: string,
  ): Promise<ConsumerInfo> {
    const d = deferred();
    nc.subscribe("$JS.API.CONSUMER.>", {
      callback: (err, msg) => {
        if (err) {
          d.reject(err);
        }
        if (msg.subject === expect) {
          d.resolve();
        }
      },
      timeout: 1000,
    });
    let ci: ConsumerInfo;
    try {
      ci = await jsm.consumers.add("A", config);
    } catch (err) {
      d.resolve();
      return Promise.reject(err);
    }
    await d;

    return Promise.resolve(ci!);
  }

  // an ephemeral with a name
  let ci = await addC({
    ack_policy: AckPolicy.Explicit,
    inactive_threshold: nanos(1000),
    name: "a",
  }, "$JS.API.CONSUMER.CREATE.A.a");
  assertExists(ci.config.inactive_threshold);

  ci = await addC({
    ack_policy: AckPolicy.Explicit,
    durable_name: "b",
  }, "$JS.API.CONSUMER.CREATE.A.b");
  assertEquals(ci.config.inactive_threshold, undefined);

  // a ephemeral with a filter
  ci = await addC({
    ack_policy: AckPolicy.Explicit,
    name: "c",
    filter_subject: "bar",
  }, "$JS.API.CONSUMER.CREATE.A.c.bar");
  assertExists(ci.config.inactive_threshold);

  // a deprecated ephemeral
  ci = await addC({
    ack_policy: AckPolicy.Explicit,
    filter_subject: "bar",
  }, "$JS.API.CONSUMER.CREATE.A");
  assertExists(ci.name);
  assertEquals(ci.config.durable_name, undefined);
  assertExists(ci.config.inactive_threshold);

  await cleanup(ns, nc);
});

async function testConsumerNameAPI(nc: NatsConnection) {
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "A",
    subjects: ["foo", "bar"],
  });

  async function addC(
    config: Partial<ConsumerConfig>,
    expect: string,
  ): Promise<ConsumerInfo> {
    const d = deferred();
    nc.subscribe("$JS.API.CONSUMER.>", {
      callback: (err, msg) => {
        if (err) {
          d.reject(err);
        }
        if (msg.subject === expect) {
          d.resolve();
        }
      },
      timeout: 1000,
    });
    let ci: ConsumerInfo;
    try {
      ci = await jsm.consumers.add("A", config);
    } catch (err) {
      d.resolve();
      return Promise.reject(err);
    }
    await d;

    return Promise.resolve(ci!);
  }

  // a named ephemeral
  await assertRejects(
    async () => {
      await addC({
        ack_policy: AckPolicy.Explicit,
        inactive_threshold: nanos(1000),
        name: "a",
      }, "$JS.API.CONSUMER.CREATE.A");
    },
    errors.InvalidArgumentError,
    "'name' requires server",
  );

  const ci = await addC({
    ack_policy: AckPolicy.Explicit,
    inactive_threshold: nanos(1000),
  }, "$JS.API.CONSUMER.CREATE.A");
  assertExists(ci.config.inactive_threshold);
  assertExists(ci.name);

  await addC({
    ack_policy: AckPolicy.Explicit,
    durable_name: "b",
  }, "$JS.API.CONSUMER.DURABLE.CREATE.A.b");
}

Deno.test("jsm - consumer name apis are not used on old servers", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.7.0")) {
    return;
  }

  // change the version of the server to force legacy apis
  const nci = nc as NatsConnectionImpl;
  nci.features.update("2.7.0");
  await testConsumerNameAPI(nc);

  await cleanup(ns, nc);
});

Deno.test("jsm - consumer name apis are not used when disabled", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }

  const nci = nc as NatsConnectionImpl;
  nci.features.disable(Feature.JS_NEW_CONSUMER_CREATE_API);
  await testConsumerNameAPI(nc);

  await cleanup(ns, nc);
});

Deno.test("jsm - mirror_direct options", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  let si = await jsm.streams.add({
    name: "A",
    allow_direct: true,
    subjects: ["a.*"],
    max_msgs_per_subject: 1,
  });
  assertEquals(si.config.allow_direct, true);

  si = await jsm.streams.add({
    name: "B",
    allow_direct: true,
    mirror_direct: true,
    mirror: {
      name: "A",
    },
    max_msgs_per_subject: 1,
  });
  assertEquals(si.config.allow_direct, true);
  assertEquals(si.config.mirror_direct, true);

  await cleanup(ns, nc);
});

Deno.test("jsm - consumers with name and durable_name", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  const { stream } = await initStream(nc);

  // should be ok
  await jsm.consumers.add(stream, {
    name: "x",
    durable_name: "x",
    ack_policy: AckPolicy.None,
  });

  // should fail from the server
  await assertRejects(
    async () => {
      await jsm.consumers.add(stream, {
        name: "y",
        durable_name: "z",
        ack_policy: AckPolicy.None,
      });
    },
    Error,
    "consumer name in subject does not match durable name in request",
  );

  await cleanup(ns, nc);
});

Deno.test("jsm - consumer name is validated", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }
  const { stream } = await initStream(nc);
  const jsm = await jetstreamManager(nc);

  function test(
    n: string,
    conf: Partial<ConsumerConfig> = {},
  ): Promise<unknown> {
    const opts = Object.assign({ name: n, ack_policy: AckPolicy.None }, conf);
    return jsm.consumers.add(stream, opts);
  }

  await assertRejects(
    async () => {
      await test("hello.world");
    },
    Error,
    "consumer 'name' cannot contain '.'",
  );

  await assertRejects(
    async () => {
      await test("hello>world");
    },
    Error,
    "consumer 'name' cannot contain '>'",
  );
  await assertRejects(
    async () => {
      await test("one*two");
    },
    Error,
    "consumer 'name' cannot contain '*'",
  );
  await assertRejects(
    async () => {
      await test(".");
    },
    Error,
    "consumer 'name' cannot contain '.'",
  );

  await cleanup(ns, nc);
});

Deno.test("jsm - discard_new_per_subject option", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.9.2")) {
    return;
  }

  const jsm = await jetstreamManager(nc);

  // discard policy new is required
  await assertRejects(
    async () => {
      await jsm.streams.add({
        name: "A",
        discard_new_per_subject: true,
        subjects: ["A.>"],
        max_msgs_per_subject: 1,
      });
    },
    Error,
    "discard new per subject requires discard new policy to be set",
  );

  const si = await jsm.streams.add({
    name: "A",
    discard: DiscardPolicy.New,
    discard_new_per_subject: true,
    subjects: ["A.>"],
    max_msgs_per_subject: 1,
  });
  assertEquals(si.config.discard_new_per_subject, true);

  const js = jetstream(nc);

  await js.publish("A.b", Empty);
  await assertRejects(
    () => {
      return js.publish("A.b", Empty);
    },
    Error,
    "maximum messages per subject exceeded",
  );

  await cleanup(ns, nc);
});

Deno.test("jsm - paginated subjects", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        max_memory_store: -1,
      },
    }),
  );

  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await initStream(nc, "a", {
    subjects: ["a.*"],
    storage: StorageType.Memory,
  });
  const proms: Promise<PubAck>[] = [];
  for (let i = 1; i <= 100_001; i++) {
    proms.push(js.publish(`a.${i}`));
    if (proms.length === 1000) {
      await Promise.all(proms);
      proms.length = 0;
    }
  }
  if (proms.length) {
    await Promise.all(proms);
  }

  const si = await jsm.streams.info("a", {
    subjects_filter: ">",
  });
  const names = Object.getOwnPropertyNames(si.state.subjects);
  assertEquals(names.length, 100_001);

  await cleanup(ns, nc);
});

Deno.test("jsm - paged stream list", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        max_memory_store: -1,
      },
    }),
  );

  const jsm = await jetstreamManager(nc);
  for (let i = 0; i < 257; i++) {
    await jsm.streams.add({
      name: `${i}`,
      subjects: [`${i}`],
      storage: StorageType.Memory,
    });
  }
  const lister = jsm.streams.list();
  const streams: StreamInfo[] = [];
  for await (const si of lister) {
    streams.push(si);
  }

  assertEquals(streams.length, 257);
  streams.sort((a, b) => {
    const na = parseInt(a.config.name);
    const nb = parseInt(b.config.name);
    return na - nb;
  });

  for (let i = 0; i < streams.length; i++) {
    assertEquals(streams[i].config.name, `${i}`);
  }

  await cleanup(ns, nc);
});

Deno.test("jsm - paged consumer infos", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        max_memory_store: -1,
      },
    }),
  );

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "A",
    subjects: ["a"],
    storage: StorageType.Memory,
  });
  for (let i = 0; i < 257; i++) {
    await jsm.consumers.add("A", {
      durable_name: `${i}`,
      ack_policy: AckPolicy.None,
    });
  }
  const lister = jsm.consumers.list("A");
  const consumers: ConsumerInfo[] = [];
  for await (const si of lister) {
    consumers.push(si);
  }

  assertEquals(consumers.length, 257);
  consumers.sort((a, b) => {
    const na = parseInt(a.name);
    const nb = parseInt(b.name);
    return na - nb;
  });

  for (let i = 0; i < consumers.length; i++) {
    assertEquals(consumers[i].name, `${i}`);
  }

  await cleanup(ns, nc);
});

Deno.test("jsm - list filter", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        max_memory_store: -1,
      },
    }),
  );

  const spec: WithRequired<Partial<StreamConfig>, "name">[] = [
    { name: "s1", subjects: ["foo"] },
    { name: "s2", subjects: ["bar"] },
    { name: "s3", subjects: ["foo.*", "bar.*"] },
    { name: "s4", subjects: ["foo-1.A"] },
    { name: "s5", subjects: ["foo.A.bar.B"] },
    { name: "s6", subjects: ["foo.C.bar.D.E"] },
  ];

  const jsm = await jetstreamManager(nc);
  for (let i = 0; i < spec.length; i++) {
    const s = spec[i];
    s.storage = StorageType.Memory;
    await jsm.streams.add(s);
  }

  const tests: { filter: string; expected: string[] }[] = [
    { filter: "foo", expected: ["s1"] },
    { filter: "bar", expected: ["s2"] },
    { filter: "*", expected: ["s1", "s2"] },
    { filter: ">", expected: ["s1", "s2", "s3", "s4", "s5", "s6"] },
    { filter: "*.A", expected: ["s3", "s4"] },
  ];

  for (let i = 0; i < tests.length; i++) {
    const lister = jsm.streams.list(tests[i].filter);
    const streams = await lister.next();
    const names = streams.map((si) => {
      return si.config.name;
    });
    names.sort();
    assertEquals(names, tests[i].expected);
  }
  await cleanup(ns, nc);
});

Deno.test("jsm - stream names list filtering subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const jsm = await jetstreamManager(nc);

  const spec = [
    { name: "s1", subjects: ["foo"] },
    { name: "s2", subjects: ["bar"] },
    { name: "s3", subjects: ["foo.*", "bar.*"] },
    { name: "s4", subjects: ["foo-1.A"] },
    { name: "s5", subjects: ["foo.A.bar.B"] },
    { name: "s6", subjects: ["foo.C.bar.D.E"] },
  ];

  const buf: Promise<StreamInfo>[] = [];
  spec.forEach(({ name, subjects }) => {
    buf.push(jsm.streams.add({ name, subjects }));
  });
  await Promise.all(buf);

  async function collect<T>(iter: Lister<T>): Promise<T[]> {
    const names: T[] = [];
    for await (const n of iter) {
      names.push(n);
    }
    return names;
  }

  const tests = [
    { filter: "foo", expected: ["s1"] },
    { filter: "bar", expected: ["s2"] },
    { filter: "*", expected: ["s1", "s2"] },
    { filter: ">", expected: ["s1", "s2", "s3", "s4", "s5", "s6"] },
    { filter: "", expected: ["s1", "s2", "s3", "s4", "s5", "s6"] },
    { filter: "*.A", expected: ["s3", "s4"] },
  ];

  async function t(filter: string, expected: string[]) {
    const lister = await jsm.streams.names(filter);
    const names = await collect<string>(lister);
    assertArrayIncludes(names, expected);
    assertEquals(names.length, expected.length);
  }

  for (let i = 0; i < tests.length; i++) {
    const { filter, expected } = tests[i];
    await t(filter, expected);
  }

  await cleanup(ns, nc);
});

Deno.test("jsm - remap domain", () => {
  const sc = {} as Partial<StreamConfig>;
  assertEquals(convertStreamSourceDomain(sc.mirror), undefined);
  assertEquals(sc.sources?.map(convertStreamSourceDomain), undefined);

  sc.mirror = {
    name: "a",
    domain: "a",
  };

  assertEquals(convertStreamSourceDomain(sc.mirror), {
    name: "a",
    external: { api: `$JS.a.API` },
  });

  const sources = [
    { name: "x", domain: "x" },
    { name: "b", external: { api: `$JS.b.API` } },
  ] as Partial<StreamSource[]>;

  const processed = sources.map(convertStreamSourceDomain);
  assertEquals(processed, [
    { name: "x", external: { api: "$JS.x.API" } },
    { name: "b", external: { api: "$JS.b.API" } },
  ]);
});

Deno.test("jsm - filter_subjects", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  await jsm.streams.add({ name, subjects: [`a.>`] });
  const ci = await jsm.consumers.add(name, {
    durable_name: "dur",
    filter_subjects: [
      "a.b",
      "a.c",
    ],
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(ci.config.filter_subject, undefined);
  assert(Array.isArray(ci.config.filter_subjects));
  assertArrayIncludes(ci.config.filter_subjects, ["a.b", "a.c"]);
  await cleanup(ns, nc);
});

Deno.test("jsm - filter_subjects rejects filter_subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  await jsm.streams.add({ name, subjects: [`a.>`] });
  await assertRejects(
    async () => {
      await jsm.consumers.add(name, {
        durable_name: "dur",
        filter_subject: "a.a",
        filter_subjects: [
          "a.b",
          "a.c",
        ],
        ack_policy: AckPolicy.Explicit,
      });
    },
    Error,
    "consumer cannot have both FilterSubject and FilterSubjects specified",
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - update filter_subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  await jsm.streams.add({ name, subjects: [`a.>`] });

  let ci = await jsm.consumers.add(name, {
    durable_name: "dur",
    filter_subject: "a.x",
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(ci.config.filter_subject, "a.x");

  ci = await jsm.consumers.update(name, "dur", {
    filter_subject: "a.y",
  });
  assertEquals(ci.config.filter_subject, "a.y");

  await cleanup(ns, nc);
});

Deno.test("jsm - update filter_subjects", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  await jsm.streams.add({ name, subjects: [`a.>`] });

  let ci = await jsm.consumers.add(name, {
    durable_name: "dur",
    filter_subjects: ["a.x"],
    ack_policy: AckPolicy.Explicit,
  });
  assertArrayIncludes(ci.config.filter_subjects!, ["a.x"]);

  ci = await jsm.consumers.update(name, "dur", {
    filter_subjects: ["a.x", "a.y"],
  });
  assertArrayIncludes(ci.config.filter_subjects!, ["a.x", "a.y"]);

  await cleanup(ns, nc);
});

Deno.test("jsm - update from filter_subject to filter_subjects", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const name = nuid.next();
  await jsm.streams.add({ name, subjects: [`a.>`] });

  let ci = await jsm.consumers.add(name, {
    durable_name: "dur",
    filter_subject: "a.x",
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(ci.config.filter_subject, "a.x");

  // fail if not removing filter_subject
  await assertRejects(
    async () => {
      await jsm.consumers.update(name, "dur", {
        filter_subjects: ["a.x", "a.y"],
      });
    },
    Error,
    "consumer cannot have both FilterSubject and FilterSubjects specified",
  );
  // now switch it
  ci = await jsm.consumers.update(name, "dur", {
    filter_subject: "",
    filter_subjects: ["a.x", "a.y"],
  });
  assertEquals(ci.config.filter_subject, undefined);
  assertArrayIncludes(ci.config.filter_subjects!, ["a.x", "a.y"]);

  // fail if not removing filter_subjects
  await assertRejects(
    async () => {
      await jsm.consumers.update(name, "dur", {
        filter_subject: "a.x",
      });
    },
    Error,
    "consumer cannot have both FilterSubject and FilterSubjects specified",
  );

  // and from filter_subjects back
  ci = await jsm.consumers.update(name, "dur", {
    filter_subject: "a.x",
    filter_subjects: [],
  });
  assertEquals(ci.config.filter_subject, "a.x");
  assertEquals(ci.config.filter_subjects!, undefined);

  await cleanup(ns, nc);
});

Deno.test("jsm - stored msg decode", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await jetstreamManager(nc) as JetStreamManagerImpl;
  const js = jetstream(nc);
  await jsm.streams.add({ name, subjects: [`a.>`], allow_direct: false });

  await js.publish("a.a", "hello");
  await js.publish("a.a", JSON.stringify({ one: "two", a: [1, 2, 3] }));

  assertEquals(
    (await jsm.streams.getMessage(name, { seq: 1 }))?.string(),
    "hello",
  );
  assertEquals((await jsm.streams.getMessage(name, { seq: 2 }))?.json(), {
    one: "two",
    a: [1, 2, 3],
  });

  await cleanup(ns, nc);
});

Deno.test("jsm - stream/consumer metadata", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc) as JetStreamManagerImpl;

  async function addStream(name: string, md?: Record<string, string>) {
    const si = await jsm.streams.add({
      name,
      subjects: [name],
      metadata: md,
    });
    if (md) {
      stripNatsMetadata(si.config.metadata);
      stripNatsMetadata(md);
      assertEquals(si.config.metadata, md || {});
    }
  }
  async function updateStream(name: string, md?: Record<string, string>) {
    const si = await jsm.streams.update(name, {
      metadata: md,
    });
    stripNatsMetadata(si.config.metadata);
    stripNatsMetadata(md);
    assertEquals(si.config.metadata, md);
  }
  async function addConsumer(
    stream: string,
    name: string,
    md?: Record<string, string>,
  ) {
    const ci = await jsm.consumers.add(stream, {
      durable_name: name,
      metadata: md,
    });
    stripNatsMetadata(ci.config.metadata);
    if (md) {
      assertEquals(ci.config.metadata, md);
    }
  }

  async function updateConsumer(
    stream: string,
    name: string,
    md?: Record<string, string>,
  ) {
    const ci = await jsm.consumers.update(stream, name, { metadata: md });
    stripNatsMetadata(ci.config.metadata);
    stripNatsMetadata(md);
    assertEquals(ci.config.metadata, md);
  }
  // we should be able to add/update metadata
  let stream = nuid.next();
  let consumer = nuid.next();
  await addStream(stream, { hello: "world" });
  await updateStream(stream, { one: "two" });
  await addConsumer(stream, consumer, { test: "true" });
  await updateConsumer(stream, consumer, { foo: "bar" });

  // fake a server version change
  (nc as NatsConnectionImpl).features.update("2.9.0");
  stream = nuid.next();
  consumer = nuid.next();
  await assertRejects(
    async () => {
      await addStream(stream, { hello: "world" });
    },
    Error,
    "stream 'metadata' requires server 2.10.0",
  );
  // add without md
  await addStream(stream);
  // should fail update w/ metadata
  await assertRejects(
    async () => {
      await updateStream(stream, { hello: "world" });
    },
    Error,
    "stream 'metadata' requires server 2.10.0",
  );
  // should fail adding consumer with md
  await assertRejects(
    async () => {
      await addConsumer(stream, consumer, { hello: "world" });
    },
    InvalidArgumentError,
    "'metadata' requires server",
  );
  // add w/o metadata
  await addConsumer(stream, consumer);
  // should fail to update consumer with md
  await assertRejects(
    async () => {
      await updateConsumer(stream, consumer, { hello: "world" });
    },
    InvalidArgumentError,
    "'metadata' requires server",
  );

  await cleanup(ns, nc);
});

Deno.test("jsm - consumer api action", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "stream", subjects: ["a"] });

  const config = {
    ack_policy: AckPolicy.Explicit,
    durable_name: "hello",
  } as ConsumerConfig;

  // testing the app, consumer update does an info
  // so testing the underlying API
  const api = jsm.consumers as ConsumerAPIImpl;
  await assertRejects(
    async () => {
      await api.add("stream", config, ConsumerApiAction.Update);
    },
    Error,
    "consumer does not exist",
  );

  await api.add("stream", config);

  // this should fail if options on the consumer changed
  config.inactive_threshold = nanos(60 * 1000);
  await assertRejects(
    async () => {
      await api.add("stream", config, ConsumerApiAction.Create);
    },
    Error,
    "consumer already exists",
  );

  await cleanup(ns, nc);
});

Deno.test("jsm - validate stream name in operations", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  const names = ["", ".", "*", ">", "\r", "\n", "\t", " "];
  const tests = [
    {
      name: "add stream",
      fn: (name: string) => {
        return jsm.streams.add({ name, subjects: ["a"] });
      },
    },
    {
      name: "stream info",
      fn: (name: string) => {
        return jsm.streams.info(name);
      },
    },
    {
      name: "stream update",
      fn: (name: string) => {
        return jsm.streams.update(name, { subjects: ["a", "b"] });
      },
    },
    {
      name: "stream purge",
      fn: (name: string) => {
        return jsm.streams.purge(name);
      },
    },
    {
      name: "stream delete",
      fn: (name: string) => {
        return jsm.streams.delete(name);
      },
    },
    {
      name: "getMessage",
      fn: (name: string) => {
        return jsm.streams.getMessage(name, { seq: 1 });
      },
    },
    {
      name: "deleteMessage",
      fn: (name: string) => {
        return jsm.streams.deleteMessage(name, 1);
      },
    },
  ];

  for (let j = 0; j < tests.length; j++) {
    const test = tests[j];
    for (let idx = 0; idx < names.length; idx++) {
      let v = names[idx];
      try {
        await test.fn(v[0]);
        if (!v[1]) {
          fail(`${test.name} - ${v} should have been rejected`);
        }
      } catch (err) {
        if (v === "\r") v = "\\r";
        if (v === "\n") v = "\\n";
        if (v === "\t") v = "\\t";
        const m = v === ""
          ? "stream name required"
          : `stream name ('${names[idx]}') cannot contain '${v}'`;
        assertEquals((err as Error).message, m, `${test.name} - ${m}`);
      }
    }
  }
  await cleanup(ns, nc);
});

Deno.test("jsm - validate consumer name", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  const stream = nuid.next();
  await jsm.streams.add({ name: stream, subjects: [stream] });

  // we don't test for empty, because consumer validation will
  // not test durable or name unless set - default is for server
  // to set name
  const tests = [".", "*", ">", "\r", "\n", "\t", " "];

  for (let idx = 0; idx < tests.length; idx++) {
    let v = tests[idx];
    try {
      await jsm.consumers.add(stream, {
        durable_name: v,
        ack_policy: AckPolicy.None,
      });
      fail(`${v} should have been rejected`);
    } catch (err) {
      if (v === "\r") v = "\\r";
      if (v === "\n") v = "\\n";
      if (v === "\t") v = "\\t";
      const m = `durable name ('${tests[idx]}') cannot contain '${v}'`;
      assertEquals((err as Error).message, m);
    }
  }

  for (let idx = 0; idx < tests.length; idx++) {
    let v = tests[idx];
    try {
      await jsm.consumers.add(stream, {
        name: v,
        ack_policy: AckPolicy.None,
      });
      fail(`${v} should have been rejected`);
    } catch (err) {
      if (v === "\r") v = "\\r";
      if (v === "\n") v = "\\n";
      if (v === "\t") v = "\\t";
      const m = `consumer 'name' cannot contain '${v}'`;
      assertEquals((err as Error).message, m);
    }
  }

  await cleanup(ns, nc);
});

Deno.test("jsm - validate consumer name in operations", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);

  const names = ["", ".", "*", ">", "\r", "\n", "\t", " "];
  const tests = [
    {
      name: "consumer info",
      fn: (name: string) => {
        return jsm.consumers.info("foo", name);
      },
    },
    {
      name: "consumer delete",
      fn: (name: string) => {
        return jsm.consumers.delete("foo", name);
      },
    },
    {
      name: "consumer update",
      fn: (name: string) => {
        return jsm.consumers.update("foo", name, { description: "foo" });
      },
    },
  ];

  for (let j = 0; j < tests.length; j++) {
    const test = tests[j];
    for (let idx = 0; idx < names.length; idx++) {
      let v = names[idx];
      try {
        await test.fn(v[0]);
        if (!v[1]) {
          fail(`${test.name} - ${v} should have been rejected`);
        }
      } catch (err) {
        if (v === "\r") v = "\\r";
        if (v === "\n") v = "\\n";
        if (v === "\t") v = "\\t";
        const m = v === ""
          ? "durable name required"
          : `durable name ('${names[idx]}') cannot contain '${v}'`;
        assertEquals((err as Error).message, m, `${test.name} - ${m}`);
      }
    }
  }
  await cleanup(ns, nc);
});

Deno.test("jsm - source transforms", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const name = nuid.next();
  const jsm = await jetstreamManager(nc);

  await jsm.streams.add({
    name,
    subjects: ["foo", "bar"],
    storage: StorageType.Memory,
  });

  const js = jetstream(nc);
  await Promise.all([
    js.publish("foo"),
    js.publish("bar"),
  ]);

  const mi = await jsm.streams.add({
    name: name + 2,
    storage: StorageType.Memory,
    mirror: {
      name,
      subject_transforms: [
        {
          src: "foo",
          dest: "foo-transformed",
        },
        {
          src: "bar",
          dest: "bar-transformed",
        },
      ],
    },
  });

  assertEquals(mi.config.mirror?.subject_transforms?.length, 2);
  const transforms = mi.config.mirror?.subject_transforms?.map((v) => {
    return v.dest;
  });
  assertExists(transforms);
  assertArrayIncludes(transforms, ["foo-transformed", "bar-transformed"]);

  const subjects = [];
  const c = await js.consumers.get(name + 2);
  const iter = await c.fetch({ max_messages: 2 });
  for await (const m of iter) {
    subjects.push(m.subject);
  }
  assertArrayIncludes(transforms, ["foo-transformed", "bar-transformed"]);
  await cleanup(ns, nc);
});

Deno.test("jsm - source transforms rejected on old servers", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const nci = nc as NatsConnectionImpl;
  nci.features.update("2.8.0");
  nci.info!.version = "2.8.0";

  const jsm = await jetstreamManager(nc);

  await assertRejects(
    async () => {
      await jsm.streams.add({
        name: "n",
        subjects: ["foo"],
        storage: StorageType.Memory,
        subject_transform: {
          src: "foo",
          dest: "transformed-foo",
        },
      });
    },
    Error,
    "stream 'subject_transform' requires server 2.10.0",
  );

  await jsm.streams.add({
    name: "src",
    subjects: ["foo", "bar"],
    storage: StorageType.Memory,
  });

  await assertRejects(
    async () => {
      await jsm.streams.add({
        name: "n",
        storage: StorageType.Memory,
        mirror: {
          name: "src",
          subject_transforms: [
            {
              src: "foo",
              dest: "foo-transformed",
            },
          ],
        },
      });
    },
    Error,
    "stream mirror 'subject_transforms' requires server 2.10.0",
  );

  await assertRejects(
    async () => {
      await jsm.streams.add(
        {
          name: "n",
          storage: StorageType.Memory,
          sources: [{
            name: "src",
            subject_transforms: [
              {
                src: "foo",
                dest: "foo-transformed",
              },
            ],
          }],
        },
      );
    },
    Error,
    "stream sources 'subject_transforms' requires server 2.10.0",
  );

  await cleanup(ns, nc);
});

Deno.test("jsm - stream compression not supported", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const nci = nc as NatsConnectionImpl;
  nci.features.update("2.9.0");
  nci.info!.version = "2.9.0";

  const jsm = await jetstreamManager(nc);

  await assertRejects(
    async () => {
      await jsm.streams.add({
        name: "n",
        subjects: ["foo"],
        storage: StorageType.File,
        compression: StoreCompression.S2,
      });
    },
    Error,
    "stream 'compression' requires server 2.10.0",
  );

  await cleanup(ns, nc);
});

Deno.test("jsm - stream compression", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  let si = await jsm.streams.add({
    name: "n",
    subjects: ["foo"],
    storage: StorageType.File,
    compression: StoreCompression.S2,
  });
  assertEquals(si.config.compression, StoreCompression.S2);

  si = await jsm.streams.update("n", { compression: StoreCompression.None });
  assertEquals(si.config.compression, StoreCompression.None);

  await cleanup(ns, nc);
});

Deno.test("jsm - stream consumer limits", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  let si = await jsm.streams.add({
    name: "map",
    subjects: ["foo"],
    storage: StorageType.Memory,
    consumer_limits: {
      max_ack_pending: 20,
      inactive_threshold: nanos(60_000),
    },
  });
  assertEquals(si.config.consumer_limits?.max_ack_pending, 20);
  assertEquals(si.config.consumer_limits?.inactive_threshold, nanos(60_000));

  const ci = await jsm.consumers.add("map", { durable_name: "map" });
  assertEquals(ci.config.max_ack_pending, 20);
  assertEquals(ci.config.inactive_threshold, nanos(60_000));

  si = await jsm.streams.update("map", {
    consumer_limits: {
      max_ack_pending: 200,
      inactive_threshold: nanos(120_000),
    },
  });
  assertEquals(si.config.consumer_limits?.max_ack_pending, 200);
  assertEquals(si.config.consumer_limits?.inactive_threshold, nanos(120_000));

  await cleanup(ns, nc);
});

Deno.test("jsm - stream consumer limits override", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.add({
    name: "map",
    subjects: ["foo"],
    storage: StorageType.Memory,
    consumer_limits: {
      max_ack_pending: 20,
      inactive_threshold: nanos(60_000),
    },
  });
  assertEquals(si.config.consumer_limits?.max_ack_pending, 20);
  assertEquals(si.config.consumer_limits?.inactive_threshold, nanos(60_000));

  const ci = await jsm.consumers.add("map", {
    durable_name: "map",
    max_ack_pending: 19,
    inactive_threshold: nanos(59_000),
  });
  assertEquals(ci.config.max_ack_pending, 19);
  assertEquals(ci.config.inactive_threshold, nanos(59_000));

  await assertRejects(
    async () => {
      await jsm.consumers.add("map", {
        durable_name: "map",
        max_ack_pending: 100,
      });
    },
    Error,
    "consumer max ack pending exceeds system limit of 20",
  );

  await cleanup(ns, nc);
});

Deno.test("jsm - stream consumer limits rejected on old servers", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const nci = nc as NatsConnectionImpl;
  nci.features.update("2.9.0");
  nci.info!.version = "2.9.0";

  const jsm = await jetstreamManager(nc);
  await assertRejects(
    async () => {
      await jsm.streams.add({
        name: "map",
        subjects: ["foo"],
        storage: StorageType.Memory,
        consumer_limits: {
          max_ack_pending: 20,
          inactive_threshold: nanos(60_000),
        },
      });
    },
    Error,
    "stream 'consumer_limits' requires server 2.10.0",
  );
  await cleanup(ns, nc);
});

Deno.test("jsm - api check not ok", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  let count = 0;
  nc.subscribe("$JS.API.INFO", {
    callback: () => {
      count++;
    },
  });

  await jetstreamManager(nc, { checkAPI: false });
  await jetstream(nc).jetstreamManager(false);
  await jetstream(nc, { checkAPI: false }).jetstreamManager();
  await jetstream(nc, { checkAPI: false }).jetstreamManager(true);
  await jetstream(nc).jetstreamManager();
  await nc.flush();
  assertEquals(count, 2);

  await cleanup(ns, nc);
});

Deno.test("jsm - api check ok", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  let count = 0;

  nc.subscribe("$JS.API.INFO", {
    callback: () => {
      count++;
    },
  });
  await jetstreamManager(nc, {});
  await jetstreamManager(nc, { checkAPI: true });
  await jetstream(nc).jetstreamManager();
  await jetstream(nc, { checkAPI: true }).jetstreamManager();
  await jetstream(nc, { checkAPI: true }).jetstreamManager(false);

  assertEquals(count, 4);
  await cleanup(ns, nc);
});

Deno.test("jsm - consumer create paused", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  jsm.streams.add({
    name: "A",
    subjects: ["a.>"],
  });

  const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
  const ci = await jsm.consumers.add("A", {
    durable_name: "a",
    ack_policy: AckPolicy.None,
    pause_until: new Date(tomorrow).toISOString(),
  });
  assertEquals(ci.paused, true);

  await cleanup(ns, nc);
});

Deno.test("jsm - pause/unpause", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  jsm.streams.add({
    name: "A",
    subjects: ["a.>"],
  });

  const ci = await jsm.consumers.add("A", {
    durable_name: "a",
    ack_policy: AckPolicy.None,
  });
  assertEquals(ci.paused, undefined);

  let pi = await jsm.consumers.pause(
    "A",
    "a",
    new Date(Date.now() + 24 * 60 * 60 * 1000),
  );
  assertEquals(pi.paused, true);

  pi = await jsm.consumers.resume("A", "a");
  assertEquals(pi.paused, false);

  await cleanup(ns, nc);
});

Deno.test("jsm - storage", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const jsm = await jetstreamManager(nc);
  let si = await jsm.streams.add({
    name: "Mem",
    subjects: ["a"],
    storage: StorageType.Memory,
  });
  assertEquals(si.config.storage, StorageType.Memory);

  let ci = await jsm.consumers.add("Mem", { name: "mc", mem_storage: true });
  assertEquals(ci.config.mem_storage, true);

  si = await jsm.streams.add({
    name: "File",
    subjects: ["b"],
    storage: StorageType.File,
  });
  assertEquals(si.config.storage, StorageType.File);

  ci = await jsm.consumers.add("File", { name: "fc", mem_storage: false });
  assertEquals(ci.config.mem_storage, undefined);

  await cleanup(ns, nc);
});

Deno.test("jsm - pull consumer priority groups", async (t) => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.11.0")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "A",
    subjects: [`a`],
  });

  await t.step("priority group is not an array", async () => {
    await assertRejects(
      () => {
        return jsm.consumers.add("A", {
          name: "a",
          ack_policy: AckPolicy.None,
          //@ts-ignore: testing
          priority_groups: "hello",
        });
      },
      Error,
      "'priority_groups' must be an array",
    );
  });

  await t.step("priority_group empty array", async () => {
    await assertRejects(
      () => {
        return jsm.consumers.add("A", {
          name: "a",
          ack_policy: AckPolicy.None,
          //@ts-ignore: testing
          priority_groups: [],
        });
      },
      Error,
      "'priority_groups' must have at least one group",
    );
  });

  await t.step("missing priority_policy", async () => {
    await assertRejects(
      () => {
        return jsm.consumers.add("A", {
          name: "a",
          ack_policy: AckPolicy.None,
          priority_groups: ["hello"],
        });
      },
      Error,
      "'priority_policy' must be 'none', 'overflow', or 'pinned_client'",
    );
  });

  await t.step("bad priority_policy ", async () => {
    await assertRejects(
      () => {
        return jsm.consumers.add("A", {
          name: "a",
          ack_policy: AckPolicy.None,
          priority_groups: ["hello"],
          //@ts-ignore: test
          priority_policy: "hello",
        });
      },
      Error,
      "'priority_policy' must be 'none', 'overflow', or 'pinned_client'",
    );
  });

  await t.step("check config", async () => {
    const ci = await jsm.consumers.add("A", {
      name: "a",
      ack_policy: AckPolicy.None,
      priority_groups: ["hello"],
      priority_policy: PriorityPolicy.Overflow,
    });
    assertEquals(ci.config.priority_policy, PriorityPolicy.Overflow);
    assertEquals(ci.config.priority_groups, ["hello"]);
  });

  await cleanup(ns, nc);
});
