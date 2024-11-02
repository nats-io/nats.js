/*
 * Copyright 2022-2024 The NATS Authors
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

import { nanos } from "@nats-io/nats-core";
import {
  AckPolicy,
  ConsumerDebugEvents,
  ConsumerEvents,
  jetstream,
  jetstreamManager,
} from "../src/mod.ts";

import { assert, assertRejects, fail } from "jsr:@std/assert";
import { initStream } from "./jstest_util.ts";
import { cleanup, jetstreamServerConf, setup } from "test_helpers";

Deno.test("409 - max expires", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "a",
    ack_policy: AckPolicy.Explicit,
    max_expires: nanos(1_000),
  });

  const js = jetstream(nc);
  const c = await js.consumers.get(stream, "a");
  await assertRejects(
    () => {
      return c.next({ expires: 30_000 });
    },
    Error,
    "exceeded maxrequestexpires",
  );

  await assertRejects(
    async () => {
      const iter = await c.fetch({ expires: 30_000 });
      for await (const _ of iter) {
        fail("shouldn't have gotten a message");
      }
    },
    Error,
    "exceeded maxrequestexpires",
  );

  const iter = await c.consume({
    expires: 2_000,
    callback: () => {
      fail("shouldn't have gotten a message");
    },
  });
  let count = 0;
  (async () => {
    for await (const s of iter.status()) {
      if (s.type === ConsumerEvents.ExceededLimit) {
        const data = s.data as { code: number; description: string };
        if (data.description.includes("exceeded maxrequestexpires")) {
          count++;
          if (count === 2) {
            iter.close();
          }
        }
      }
    }
  })().then();
  await iter.closed();
  assert(count >= 2);
  await cleanup(ns, nc);
});

Deno.test("409 - max message size", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream, subj } = await initStream(nc);

  const js = jetstream(nc);
  await js.publish(subj, new Uint8Array(1024));

  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(stream, {
    durable_name: "a",
    ack_policy: AckPolicy.Explicit,
  });

  const c = await js.consumers.get(stream, "a");
  const msgs = await c.fetch({ max_bytes: 10 });
  (async () => {
    for await (const s of msgs.status()) {
      if (s.type === ConsumerDebugEvents.Discard) {
        const data = s.data as { bytesLeft: number };
        if (data.bytesLeft === 10) {
          msgs.stop();
        }
      }
    }
  })().then();
  for await (const _ of msgs) {
    fail("shoudn't have gotten any messages");
  }

  const iter = await c.consume({
    max_bytes: 10,
    callback: () => {
      fail("this shouldn't have been called");
    },
  });
  let count = 0;
  for await (const s of iter.status()) {
    if (s.type === ConsumerDebugEvents.Discard) {
      const data = s.data as { bytesLeft: number };
      count++;
      if (data.bytesLeft === 10) {
        if (count >= 2) {
          iter.close();
        }
      }
    }
  }
  await iter.closed();
  assert(count >= 2);
  await cleanup(ns, nc);
});

Deno.test("409 - max batch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);

  const jsm = await jetstreamManager(nc);

  // only one pull request
  await jsm.consumers.add(stream, {
    durable_name: "a",
    ack_policy: AckPolicy.Explicit,
    max_batch: 10,
  });

  const js = jetstream(nc);
  const c = await js.consumers.get(stream, "a");

  await assertRejects(
    async () => {
      const msgs = await c.fetch({ max_messages: 100, expires: 1_000 });
      for await (const _ of msgs) {
        // nothing
      }
    },
    Error,
    "exceeded maxrequestbatch",
  );

  let count = 0;
  const iter = await c.consume({
    max_messages: 100,
    expires: 2_000,
    callback: () => {},
  });
  for await (const s of iter.status()) {
    if (s.type === ConsumerEvents.ExceededLimit) {
      const data = s.data as { code: number; description: string };
      if (data.description.includes("exceeded maxrequestbatch")) {
        count++;
        if (count >= 2) {
          iter.stop();
        }
      }
    }
  }
  await iter.closed();
  assert(count >= 2);

  await cleanup(ns, nc);
});

Deno.test("409 - max waiting", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const { stream } = await initStream(nc);

  const jsm = await jetstreamManager(nc);

  // only one pull request
  await jsm.consumers.add(stream, {
    durable_name: "a",
    ack_policy: AckPolicy.Explicit,
    max_waiting: 1,
  });

  const js = jetstream(nc);
  const c = await js.consumers.get(stream, "a");

  // consume with an open pull
  const blocking = await c.consume({ callback: () => {} });

  await assertRejects(
    () => {
      return c.next({ expires: 1_000 });
    },
    Error,
    "exceeded maxwaiting",
  );

  await assertRejects(
    async () => {
      const msgs = await c.fetch({ expires: 1_000 });
      for await (const _ of msgs) {
        // nothing
      }
    },
    Error,
    "exceeded maxwaiting",
  );

  let count = 0;

  const iter = await c.consume({ expires: 1_000, callback: () => {} });
  for await (const s of iter.status()) {
    if (s.type === ConsumerEvents.ExceededLimit) {
      const data = s.data as { code: number; description: string };
      if (data.description.includes("exceeded maxwaiting")) {
        count++;
        if (count >= 2) {
          iter.stop();
        }
      }
    }
  }
  await iter.closed();
  assert(count >= 2);

  // stop the consumer blocking
  blocking.stop();
  await blocking.closed();
  await cleanup(ns, nc);
});
