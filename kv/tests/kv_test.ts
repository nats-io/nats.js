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
  collect,
  compare,
  deferred,
  delay,
  Empty,
  nanos,
  nuid,
  parseSemVer,
  syncIterator,
} from "@nats-io/nats-core/internal";
import type {
  ConnectionOptions,
  NatsConnection,
  NatsConnectionImpl,
  QueuedIterator,
} from "@nats-io/nats-core/internal";

import {
  DirectMsgHeaders,
  DiscardPolicy,
  jetstream,
  jetstreamManager,
  StorageType,
} from "@nats-io/jetstream";

import type {
  JetStreamOptions,
  PushConsumer,
} from "@nats-io/jetstream/internal";

import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert";

import type { KV, KvEntry, KvOptions, KvWatchEntry } from "../src/types.ts";

import type { Bucket } from "../src/mod.ts";

import { KvWatchInclude } from "../src/types.ts";

import { Base64KeyCodec, NoopKvCodecs } from "../src/mod.ts";

import { kvPrefix, validateBucket, validateKey } from "../src/internal_mod.ts";

import {
  cleanup,
  connect,
  jetstreamServerConf,
  Lock,
  NatsServer,
  notCompatible,
  setup,
} from "test_helpers";
import type { QueuedIteratorImpl } from "@nats-io/nats-core/internal";
import { Kvm } from "../src/kv.ts";
import { flakyTest } from "../../test_helpers/mod.ts";

Deno.test("kv - key validation", () => {
  const bad = [
    " x y",
    "x ",
    "x!",
    "xx$",
    "*",
    ">",
    "x.>",
    "x.*",
    ".",
    ".x",
    ".x.",
    "x.",
  ];
  for (const v of bad) {
    assertThrows(
      () => {
        validateKey(v);
      },
      Error,
      "invalid key",
      `expected '${v}' to be invalid key`,
    );
  }

  const good = [
    "foo",
    "_foo",
    "-foo",
    "_kv_foo",
    "foo123",
    "123",
    "a/b/c",
    "a.b.c",
  ];
  for (const v of good) {
    try {
      validateKey(v);
    } catch (err) {
      throw new Error(
        `expected '${v}' to be a valid key, but was rejected: ${
          (err as Error).message
        }`,
      );
    }
  }
});

Deno.test("kv - bucket name validation", () => {
  const bad = [" B", "!", "x/y", "x>", "x.x", "x.*", "x.>", "x*", "*", ">"];
  for (const v of bad) {
    assertThrows(
      () => {
        validateBucket(v);
      },
      Error,
      "invalid bucket name",
      `expected '${v}' to be invalid bucket name`,
    );
  }

  const good = [
    "B",
    "b",
    "123",
    "1_2_3",
    "1-2-3",
  ];
  for (const v of good) {
    try {
      validateBucket(v);
    } catch (err) {
      throw new Error(
        `expected '${v}' to be a valid bucket name, but was rejected: ${
          (err as Error).message
        }`,
      );
    }
  }
});

Deno.test("kv - list kv", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });
  const kvm = new Kvm(nc);
  let kvs = await kvm.list().next();
  assertEquals(kvs.length, 0);

  await kvm.create("kv");

  kvs = await kvm.list().next();
  assertEquals(kvs.length, 1);
  assertEquals(kvs[0].bucket, `kv`);

  // test names as well
  const names = await (await jsm.streams.names()).next();
  assertEquals(names.length, 2);
  assertArrayIncludes(names, ["A", "KV_kv"]);

  await cleanup(ns, nc);
});
Deno.test("kv - init creates stream", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  let streams = await jsm.streams.list().next();
  assertEquals(streams.length, 0);

  const n = nuid.next();
  await new Kvm(nc).create(n);

  streams = await jsm.streams.list().next();
  assertEquals(streams.length, 1);
  assertEquals(streams[0].config.name, `KV_${n}`);

  await cleanup(ns, nc);
});

Deno.test("kv - bind to existing KV", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  let streams = await jsm.streams.list().next();
  assertEquals(streams.length, 0);

  const n = nuid.next();
  const js = jetstream(nc);
  await new Kvm(js).create(n, { history: 10 });

  streams = await jsm.streams.list().next();
  assertEquals(streams.length, 1);
  assertEquals(streams[0].config.name, `KV_${n}`);

  const kv = await new Kvm(js).open(n);
  const status = await kv.status();
  assertEquals(status.bucket, `${n}`);
  await crud(kv as Bucket);
  await cleanup(ns, nc);
});

async function crud(bucket: Bucket): Promise<void> {
  const status = await bucket.status();
  assertEquals(status.values, 0);
  assertEquals(status.history, 10);
  assertEquals(status.bucket, bucket.bucket);
  assertEquals(status.ttl, 0);
  assertEquals(status.streamInfo.config.name, `${kvPrefix}${bucket.bucket}`);

  await bucket.put("k", "hello");
  let r = await bucket.get("k");
  assertEquals(r!.string(), "hello");

  await bucket.put("k", "bye");
  r = await bucket.get("k");
  assertEquals(r!.string(), "bye");

  await bucket.delete("k");
  r = await bucket.get("k");
  assert(r);
  assertEquals(r.operation, "DEL");

  const buf: string[] = [];
  const values = await bucket.history();
  for await (const r of values) {
    buf.push(r.string());
  }
  assertEquals(values.getProcessed(), 3);
  assertEquals(buf.length, 3);
  assertEquals(buf[0], "hello");
  assertEquals(buf[1], "bye");
  assertEquals(buf[2], "");

  const pr = await bucket.purgeBucket();
  assertEquals(pr.purged, 3);
  assert(pr.success);

  const ok = await bucket.destroy();
  assert(ok);

  const streams = await bucket.jsm.streams.list().next();
  assertEquals(streams.length, 0);
}

Deno.test("kv - crud", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const n = nuid.next();
  const js = jetstream(nc);
  const bucket = await new Kvm(js).create(n, { history: 10 }) as Bucket;
  await crud(bucket);
  await cleanup(ns, nc);
});

Deno.test("kv - codec crud", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const jsm = await jetstreamManager(nc);
  const streams = await jsm.streams.list().next();
  assertEquals(streams.length, 0);

  const n = nuid.next();
  const js = jetstream(nc);
  const bucket = await new Kvm(js).create(n, {
    history: 10,
    codec: {
      key: Base64KeyCodec(),
      value: NoopKvCodecs().value,
    },
  }) as Bucket;
  await crud(bucket);
  await cleanup(ns, nc);
});

Deno.test("kv - history", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const n = nuid.next();
  const js = jetstream(nc);
  const bucket = await new Kvm(js).create(n, { history: 2 });
  let status = await bucket.status();
  assertEquals(status.values, 0);
  assertEquals(status.history, 2);

  await bucket.put("A", Empty);
  await bucket.put("A", Empty);
  await bucket.put("A", Empty);
  await bucket.put("A", Empty);

  status = await bucket.status();
  assertEquals(status.values, 2);
  await cleanup(ns, nc);
});

Deno.test("kv - history multiple keys", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const n = nuid.next();
  const js = jetstream(nc);
  const bucket = await new Kvm(js).create(n, { history: 2 });

  await bucket.put("A", Empty);
  await bucket.put("B", Empty);
  await bucket.put("C", Empty);
  await bucket.put("D", Empty);

  const iter = await bucket.history({ key: ["A", "D"] });
  const buf = [];
  for await (const e of iter) {
    buf.push(e.key);
  }

  assertEquals(buf.length, 2);
  assertArrayIncludes(buf, ["A", "D"]);

  await cleanup(ns, nc);
});

Deno.test("kv - cleanups/empty", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const nci = nc as NatsConnectionImpl;

  const n = nuid.next();
  const js = jetstream(nc);
  const bucket = await new Kvm(js).create(n);
  assertEquals(await bucket.get("x"), null);

  const h = await bucket.history();
  assertEquals(h.getReceived(), 0);

  const keys = await collect(await bucket.keys());
  assertEquals(keys.length, 0);

  // mux should be created
  const min = nci.protocol.subscriptions.getMux() ? 1 : 0;

  assertEquals(nci.protocol.subscriptions.subs.size, min);

  await cleanup(ns, nc);
});

Deno.test("kv - history and watch cleanup", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const n = nuid.next();
  const js = jetstream(nc);
  const bucket = await new Kvm(js).create(n);
  await bucket.put("a", Empty);
  await bucket.put("b", Empty);
  await bucket.put("c", Empty);

  const h = await bucket.history();
  for await (const _e of h) {
    // aborted
    break;
  }

  const w = await bucket.watch({});
  setTimeout(() => {
    bucket.put("hello", "world");
  }, 250);
  for await (const e of w) {
    if (e.isUpdate) {
      break;
    }
  }

  await delay(500);

  // need to give some time for promises to be resolved
  const nci = nc as NatsConnectionImpl;
  const min = nci.protocol.subscriptions.getMux() ? 1 : 0;
  assertEquals(nci.protocol.subscriptions.size(), min);

  await cleanup(ns, nc);
});

Deno.test("kv - bucket watch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const n = nuid.next();
  const js = jetstream(nc);
  const b = await new Kvm(js).create(n, { history: 10 });
  const m: Map<string, string> = new Map();
  const iter = await b.watch();
  const done = (async () => {
    for await (const r of iter) {
      if (r.operation === "DEL") {
        m.delete(r.key);
      } else {
        m.set(r.key, r.string());
      }
      if (r.key === "x") {
        break;
      }
    }
  })();

  await b.put("a", "1");
  await b.put("b", "2");
  await b.put("c", "3");
  await b.put("a", "2");
  await b.put("b", "3");
  await b.delete("c");
  await b.put("x", Empty);

  await done;
  await delay(0);

  assertEquals(iter.getProcessed(), 7);
  assertEquals(m.get("a"), "2");
  assertEquals(m.get("b"), "3");
  assert(!m.has("c"));
  assertEquals(m.get("x"), "");

  const nci = nc as NatsConnectionImpl;
  // mux should be created
  const min = nci.protocol.subscriptions.getMux() ? 1 : 0;
  assertEquals(nci.protocol.subscriptions.subs.size, min);

  await cleanup(ns, nc);
});

async function keyWatch(bucket: Bucket): Promise<void> {
  const m: Map<string, string> = new Map();

  const iter = await bucket.watch({ key: "a.>" });
  const done = (async () => {
    for await (const r of iter) {
      if (r.operation === "DEL") {
        m.delete(r.key);
      } else {
        m.set(r.key, r.string());
      }
      if (r.key === "a.x") {
        break;
      }
    }
  })();

  await bucket.put("a.b", "1");
  await bucket.put("b.b", "2");
  await bucket.put("c.b", "3");
  await bucket.put("a.b", "2");
  await bucket.put("b.b", "3");
  await bucket.delete("c.b");
  await bucket.put("a.x", Empty);
  await done;

  assertEquals(iter.getProcessed(), 3);
  assertEquals(m.get("a.b"), "2");
  assertEquals(m.get("a.x"), "");
}

Deno.test("kv - key watch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const bucket = await new Kvm(js).create(nuid.next()) as Bucket;
  await keyWatch(bucket);
  await delay(0);

  const nci = nc as NatsConnectionImpl;
  const min = nci.protocol.subscriptions.getMux() ? 1 : 0;
  assertEquals(nci.protocol.subscriptions.subs.size, min);

  await cleanup(ns, nc);
});

Deno.test("kv - codec key watch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const bucket = await new Kvm(js).create(nuid.next(), {
    history: 10,
    codec: {
      key: Base64KeyCodec(),
      value: NoopKvCodecs().value,
    },
  }) as Bucket;
  await keyWatch(bucket);
  await delay(0);

  const nci = nc as NatsConnectionImpl;
  const min = nci.protocol.subscriptions.getMux() ? 1 : 0;
  assertEquals(nci.protocol.subscriptions.subs.size, min);

  await cleanup(ns, nc);
});

async function keys(b: Bucket): Promise<void> {
  await b.put("a", "1");
  await b.put("b", "2");
  await b.put("c.c.c", "3");
  await b.put("a", "2");
  await b.put("b", "3");
  await b.delete("c.c.c");
  await b.put("x", Empty);

  const keys = await collect(await b.keys());
  assertEquals(keys.length, 3);
  assertArrayIncludes(keys, ["a", "b", "x"]);
}

Deno.test("kv - keys", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next());
  await keys(b as Bucket);

  const nci = nc as NatsConnectionImpl;
  const min = nci.protocol.subscriptions.getMux() ? 1 : 0;
  assertEquals(nci.protocol.subscriptions.subs.size, min);

  await cleanup(ns, nc);
});

Deno.test("kv - codec keys", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next(), {
    history: 10,
    codec: {
      key: Base64KeyCodec(),
      value: NoopKvCodecs().value,
    },
  });
  await keys(b as Bucket);

  const nci = nc as NatsConnectionImpl;
  const min = nci.protocol.subscriptions.getMux() ? 1 : 0;
  assertEquals(nci.protocol.subscriptions.subs.size, min);

  await cleanup(ns, nc);
});

Deno.test("kv - ttl", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next(), { ttl: 1000 }) as Bucket;

  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.info(b.stream);
  assertEquals(si.config.max_age, nanos(1000));

  assertEquals(await b.get("x"), null);
  await b.put("x", "hello");
  const e = await b.get("x");
  assert(e);
  assertEquals(e.string(), "hello");
  await delay(5000);
  assertEquals(await b.get("x"), null);

  await cleanup(ns, nc);
});

Deno.test("kv - no ttl", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next()) as Bucket;

  await b.put("x", "hello");
  let e = await b.get("x");
  assert(e);
  assertEquals(e.string(), "hello");

  await delay(1500);
  e = await b.get("x");
  assert(e);
  assertEquals(e.string(), "hello");

  await cleanup(ns, nc);
});

Deno.test("kv - complex key", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next()) as Bucket;

  await b.put("x.y.z", "hello");
  const e = await b.get("x.y.z");
  assertEquals(e?.string(), "hello");

  const d = deferred<KvEntry>();
  let iter = await b.watch({ key: "x.y.>" });
  await (async () => {
    for await (const r of iter) {
      d.resolve(r);
      break;
    }
  })();

  const vv = await d;
  assertEquals(vv.string(), "hello");

  const dd = deferred<KvEntry>();
  iter = await b.history({ key: "x.y.>" });
  await (async () => {
    for await (const r of iter) {
      dd.resolve(r);
      break;
    }
  })();

  const vvv = await dd;
  assertEquals(vvv.string(), "hello");

  await cleanup(ns, nc);
});

Deno.test("kv - remove key", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next()) as Bucket;

  await b.put("a.b", "ab");
  let v = await b.get("a.b");
  assert(v);
  assertEquals(v.string(), "ab");

  await b.purge("a.b");
  v = await b.get("a.b");
  assert(v);
  assertEquals(v.operation, "PURGE");

  const status = await b.status();
  // the purged value
  assertEquals(status.values, 1);

  await cleanup(ns, nc);
});

Deno.test("kv - remove subkey", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next()) as Bucket;
  await b.put("a", Empty);
  await b.put("a.b", Empty);
  await b.put("a.c", Empty);

  let keys = await collect(await b.keys());
  assertEquals(keys.length, 3);
  assertArrayIncludes(keys, ["a", "a.b", "a.c"]);

  await b.delete("a.*");
  keys = await collect(await b.keys());
  assertEquals(keys.length, 1);
  assertArrayIncludes(keys, ["a"]);

  await cleanup(ns, nc);
});

Deno.test("kv - create key", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next()) as Bucket;
  await b.create("a", Empty);
  await assertRejects(
    async () => {
      await b.create("a", "a");
    },
    Error,
    "wrong last sequence: 1",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("kv - update key", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next()) as Bucket;
  const seq = await b.create("a", Empty);
  await assertRejects(
    async () => {
      await b.update("a", "a", 100);
    },
    Error,
    "wrong last sequence: 1",
    undefined,
  );

  await b.update("a", "b", seq);

  await cleanup(ns, nc);
});

Deno.test("kv - internal consumer", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  async function getCount(name: string): Promise<number> {
    const js = jetstream(nc);
    const b = await new Kvm(js).create(name) as Bucket;
    const watch = await b.watch() as QueuedIteratorImpl<unknown>;
    const ci = await (watch._data as PushConsumer).info(true);
    return ci.num_pending || 0;
  }

  const name = nuid.next();
  const js = jetstream(nc);
  const b = await new Kvm(js).create(name) as Bucket;
  assertEquals(await getCount(name), 0);

  await b.put("a", Empty);
  assertEquals(await getCount(name), 1);

  await cleanup(ns, nc);
});

Deno.test("kv - is wildcard delete implemented", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const name = nuid.next();
  const js = jetstream(nc);
  const b = await new Kvm(js).create(name, { history: 10 }) as Bucket;
  await b.put("a", Empty);
  await b.put("a.a", Empty);
  await b.put("a.b", Empty);
  await b.put("a.b.c", Empty);

  let keys = await collect(await b.keys());
  assertEquals(keys.length, 4);

  await b.delete("a.*");
  keys = await collect(await b.keys());
  assertEquals(keys.length, 2);

  // this was a manual delete, so we should have tombstones
  // for all the deleted entries
  let deleted = 0;
  const w = await b.watch();
  await (async () => {
    for await (const e of w) {
      if (e.operation === "DEL") {
        deleted++;
      }
      if (e.delta === 0) {
        break;
      }
    }
  })();
  assertEquals(deleted, 2);

  await nc.close();
  await ns.stop();
});

Deno.test("kv - delta", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const name = nuid.next();
  const js = jetstream(nc);
  const b = await new Kvm(js).create(name) as Bucket;
  await b.put("a", Empty);
  await b.put("a.a", Empty);
  await b.put("a.b", Empty);
  await b.put("a.b.c", Empty);

  const w = await b.history();
  await (async () => {
    let i = 0;
    let delta = 4;
    for await (const e of w) {
      assertEquals(e.revision, ++i);
      assertEquals(e.delta, --delta);
      if (e.delta === 0) {
        break;
      }
    }
  })();

  await nc.close();
  await ns.stop();
});

Deno.test("kv - watch and history headers only", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);
  const b = await new Kvm(js).create("bucket") as Bucket;
  await b.put("key1", "aaa");

  async function getEntry(
    qip: Promise<QueuedIterator<KvEntry>>,
  ): Promise<KvEntry> {
    const iter = await qip;
    const p = deferred<KvEntry>();
    (async () => {
      for await (const e of iter) {
        p.resolve(e);
        break;
      }
    })().then();

    return p;
  }

  async function check(pe: Promise<KvEntry>): Promise<void> {
    const e = await pe;
    assertEquals(e.key, "key1");
    assertEquals(e.value, Empty);
    assertEquals(e.length, 3);
  }

  await check(getEntry(b.watch({ key: "key1", headers_only: true })));
  await check(getEntry(b.history({ key: "key1", headers_only: true })));
  await cleanup(ns, nc);
});

Deno.test("kv - mem and file", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);
  const d = await new Kvm(js).create("default") as Bucket;
  assertEquals((await d.status()).storage, StorageType.File);

  const f = await new Kvm(js).create("file", {
    storage: StorageType.File,
  }) as Bucket;
  assertEquals((await f.status()).storage, StorageType.File);

  const m = await new Kvm(js).create("mem", {
    storage: StorageType.Memory,
  }) as Bucket;
  assertEquals((await m.status()).storage, StorageType.Memory);

  await cleanup(ns, nc);
});

Deno.test("kv - example", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);

  const kv = await new Kvm(js).create("testing", { history: 5 });

  // create an entry - this is similar to a put, but will fail if the
  // key exists
  await kv.create("hello.world", "hi");

  // Values in KV are stored as KvEntries:
  // {
  //   bucket: string,
  //   key: string,
  //   value: Uint8Array,
  //   created: Date,
  //   revision: number,
  //   delta?: number,
  //   operation: "PUT"|"DEL"|"PURGE"
  // }
  // The operation property specifies whether the value was
  // updated (PUT), deleted (DEL) or purged (PURGE).

  // you can monitor values modification in a KV by watching.
  // You can watch specific key subset or everything.
  // Watches start with the latest value for each key in the
  // set of keys being watched - in this case all keys
  const watch = await kv.watch();
  (async () => {
    for await (const _e of watch) {
      // do something with the change
    }
  })().then();

  // update the entry
  await kv.put("hello.world", "world");
  // retrieve the KvEntry storing the value
  // returns null if the value is not found
  const e = await kv.get("hello.world");
  assert(e);
  // initial value of "hi" was overwritten above
  assertEquals(e.string(), "world");

  const buf: string[] = [];
  const keys = await kv.keys();
  await (async () => {
    for await (const k of keys) {
      buf.push(k);
    }
  })();
  assertEquals(buf.length, 1);
  assertEquals(buf[0], "hello.world");

  const h = await kv.history({ key: "hello.world" });
  await (async () => {
    for await (const _e of h) {
      // do something with the historical value
      // you can test e.operation for "PUT", "DEL", or "PURGE"
      // to know if the entry is a marker for a value set
      // or for a deletion or purge.
    }
  })();

  // deletes the key - the delete is recorded
  await kv.delete("hello.world");

  // purge is like delete, but all history values
  // are dropped and only the purge remains.
  await kv.purge("hello.world");

  // stop the watch operation above
  watch.stop();

  // danger: destroys all values in the KV!
  await kv.destroy();

  await cleanup(ns, nc);
});

function setupCrossAccount(): Promise<NatsServer> {
  const conf = {
    accounts: {
      A: {
        jetstream: true,
        users: [{ user: "a", password: "a" }],
        exports: [
          { service: "$JS.API.>" },
          { service: "$KV.>" },
          { stream: "forb.>" },
        ],
      },
      B: {
        users: [{ user: "b", password: "b" }],
        imports: [
          { service: { subject: "$KV.>", account: "A" }, to: "froma.$KV.>" },
          { service: { subject: "$JS.API.>", account: "A" }, to: "froma.>" },
          { stream: { subject: "forb.>", account: "A" } },
        ],
      },
    },
  };
  return NatsServer.start(jetstreamServerConf(conf));
}

async function makeKvAndClient(
  opts: ConnectionOptions,
  jsopts: Partial<JetStreamOptions> = {},
): Promise<{ nc: NatsConnection; kv: KV }> {
  const nc = await connect(opts);
  const js = jetstream(nc, jsopts);
  const kv = await new Kvm(js).create("a");
  return { nc, kv };
}

Deno.test("kv - cross account history", async () => {
  const ns = await setupCrossAccount();

  async function checkHistory(kv: KV, trace?: string): Promise<void> {
    const ap = deferred();
    const bp = deferred();
    const cp = deferred();
    const ita = await kv.history();
    const done = (async () => {
      for await (const e of ita) {
        if (trace) {
          console.log(`${trace}: ${e.key}`, e);
        }
        switch (e.key) {
          case "A":
            ap.resolve();
            break;
          case "B":
            bp.resolve();
            break;
          case "C":
            cp.resolve();
            break;
          default:
            // nothing
        }
      }
    })();

    await Promise.all([ap, bp, cp]);
    ita.stop();
    await done;
  }
  const { nc: nca, kv: kva } = await makeKvAndClient({
    port: ns.port,
    user: "a",
    pass: "a",
  });
  await kva.put("A", "A");
  await kva.put("B", "B");
  await kva.delete("B");

  const { nc: ncb, kv: kvb } = await makeKvAndClient({
    port: ns.port,
    user: "b",
    pass: "b",
    inboxPrefix: "forb",
  }, { apiPrefix: "froma" });
  await kvb.put("C", "C");

  await Promise.all([checkHistory(kva), checkHistory(kvb)]);

  await cleanup(ns, nca, ncb);
});

Deno.test("kv - cross account watch", async () => {
  const ns = await setupCrossAccount();

  async function checkWatch(kv: KV, trace?: string): Promise<void> {
    const ap = deferred();
    const bp = deferred();
    const cp = deferred();
    const ita = await kv.watch();
    const done = (async () => {
      for await (const e of ita) {
        if (trace) {
          console.log(`${trace}: ${e.key}`, e);
        }
        switch (e.key) {
          case "A":
            ap.resolve();
            break;
          case "B":
            bp.resolve();
            break;
          case "C":
            cp.resolve();
            break;
          default:
            // nothing
        }
      }
    })();

    await Promise.all([ap, bp, cp]);
    ita.stop();
    await done;
  }

  const { nc: nca, kv: kva } = await makeKvAndClient({
    port: ns.port,
    user: "a",
    pass: "a",
  });
  const { nc: ncb, kv: kvb } = await makeKvAndClient({
    port: ns.port,
    user: "b",
    pass: "b",
    inboxPrefix: "forb",
  }, { apiPrefix: "froma" });

  const proms = [checkWatch(kva), checkWatch(kvb)];
  await Promise.all([nca.flush(), ncb.flush()]);

  await kva.put("A", "A");
  await kva.put("B", "B");
  await kvb.put("C", "C");
  await Promise.all(proms);

  await cleanup(ns, nca, ncb);
});

Deno.test("kv - watch iter stops", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);
  const b = await new Kvm(js).create("a") as Bucket;
  const watch = await b.watch();
  const done = (async () => {
    for await (const _e of watch) {
      // do nothing
    }
  })();

  watch.stop();
  await done;
  await cleanup(ns, nc);
});

Deno.test("kv - defaults to discard new - if server 2.7.2", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);
  const b = await new Kvm(js).create("a") as Bucket;
  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.info(b.stream);
  const v272 = parseSemVer("2.7.2");
  const serv = (nc as NatsConnectionImpl).getServerVersion();
  assert(serv !== undefined, "should have a server version");
  const v = compare(serv, v272);
  const discard = v >= 0 ? DiscardPolicy.New : DiscardPolicy.Old;
  assertEquals(si.config.discard, discard);
  await cleanup(ns, nc);
});

Deno.test("kv - initialized watch empty", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);

  const b = await new Kvm(js).create("a") as Bucket;
  const iter = await b.watch();
  const done = (async () => {
    for await (const _e of iter) {
      // nothing
    }
  })();

  await delay(250);
  assertEquals(0, iter.getReceived());
  iter.stop();
  await done;
  await cleanup(ns, nc);
});

Deno.test("kv - initialized watch with modifications", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);

  const b = await new Kvm(js).create("a") as Bucket;

  await b.put("A", Empty);
  await b.put("B", Empty);
  await b.put("C", Empty);

  setTimeout(async () => {
    for (let i = 0; i < 100; i++) {
      await b.put(i.toString(), Empty);
    }
  });
  const iter = await b.watch();

  let history = 0;

  // we are expecting 103
  const lock = Lock(103);
  (async () => {
    for await (const e of iter) {
      if (!e.isUpdate) {
        history++;
      }
      lock.unlock();
    }
  })().then();
  // we don't really know when this happened
  assert(103 > history);
  await lock;

  //@ts-ignore: testing
  const oc = iter._data as PushConsumer;
  const ci = await oc.info();
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.consumer_seq, 103);

  await cleanup(ns, nc);
});

Deno.test("kv - get revision", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);

  const b = await new Kvm(js).create(nuid.next(), { history: 3 }) as Bucket;

  async function check(key: string, value: string | null, revision = 0) {
    const e = await b.get(key, { revision });
    if (value === null) {
      assertEquals(e, null);
    } else {
      assertEquals(e!.string(), value);
    }
  }

  await b.put("A", "a");
  await b.put("A", "b");
  await b.put("A", "c");

  // expect null, as sequence 1, holds "A"
  await check("B", null, 1);

  await check("A", "c");
  await check("A", "a", 1);
  await check("A", "b", 2);

  await b.put("A", "d");
  await check("A", "d");
  await check("A", null, 1);

  await cleanup(ns, nc);
});

Deno.test("kv - purge deletes", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);

  const b = await new Kvm(js).create("a") as Bucket;

  // keep the marker if delete is younger
  await b.put("a", Empty);
  await b.put("b", Empty);
  await b.put("c", Empty);
  await b.delete("a");
  await b.delete("c");
  await delay(1000);
  await b.delete("b");

  const pr = await b.purgeDeletes(700);
  assertEquals(pr.purged, 2);
  assertEquals(await b.get("a"), null);
  assertEquals(await b.get("c"), null);

  const e = await b.get("b");
  assertEquals(e?.operation, "DEL");

  await cleanup(ns, nc);
});

Deno.test("kv - allow direct", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);

  async function test(
    name: string,
    opts: Partial<KvOptions>,
    direct: boolean,
  ): Promise<void> {
    const kv = await new Kvm(js).create(name, opts) as Bucket;
    assertEquals(kv.direct, direct);
    const si = await jsm.streams.info(kv.bucketName());
    assertEquals(si.config.allow_direct, direct);
  }

  // default is not specified but allowed by the server
  await test(nuid.next(), { history: 1 }, true);
  // user opted to no direct
  await test(nuid.next(), { history: 1, allow_direct: false }, false);
  // user opted for direct
  await test(nuid.next(), { history: 1, allow_direct: true }, true);

  // now we create a kv that enables it
  const xkv = await new Kvm(js).create("X") as Bucket;
  assertEquals(xkv.direct, true);

  // but the client opts-out of the direct
  const xc = await new Kvm(js).create("X", { allow_direct: false }) as Bucket;
  assertEquals(xc.direct, false);

  // now the creator disables it, but the client wants it
  const ykv = await new Kvm(js).create("Y", { allow_direct: false }) as Bucket;
  assertEquals(ykv.direct, false);
  const yc = await new Kvm(js).create("Y", { allow_direct: true }) as Bucket;
  assertEquals(yc.direct, false);

  // now let's pretend we got a server that doesn't support it
  const nci = nc as NatsConnectionImpl;
  nci.features.update("2.8.0");
  nci.info!.version = "2.8.0";

  await assertRejects(
    async () => {
      await test(nuid.next(), { history: 1, allow_direct: true }, false);
    },
    Error,
    "allow_direct is not available on server version",
  );

  await cleanup(ns, nc);
});

Deno.test("kv - direct message", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }

  const js = jetstream(nc);

  const kv = await new Kvm(js).create("a", { allow_direct: true, history: 3 });
  assertEquals(await kv.get("a"), null);

  await kv.put("a", "hello");

  const m = await kv.get("a");
  assert(m !== null);
  assertEquals(m.key, "a");
  assertEquals(m.delta, 0);
  assertEquals(m.revision, 1);
  assertEquals(m.operation, "PUT");
  assertEquals(m.bucket, "a");

  await kv.delete("a");

  const d = await kv.get("a");
  assert(d !== null);
  assertEquals(d.key, "a");
  assertEquals(d.delta, 0);
  assertEquals(d.revision, 2);
  assertEquals(d.operation, "DEL");
  assertEquals(d.bucket, "a");

  await kv.put("c", "hi");
  await kv.put("c", "hello");

  // should not fail
  await kv.get("c");

  const o = await kv.get("c", { revision: 3 });
  assert(o !== null);
  assertEquals(o.revision, 3);

  await cleanup(ns, nc);
});

Deno.test("kv - republish", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }

  const js = jetstream(nc);
  const kv = await new Kvm(js).create("test", {
    republish: {
      src: ">",
      dest: "republished-kv.>",
    },
  }) as Bucket;

  const sub = nc.subscribe("republished-kv.>", { max: 1 });
  (async () => {
    for await (const m of sub) {
      assertEquals(m.subject, `republished-kv.${kv.subjectForKey("hello")}`);
      assertEquals(m.string(), "world");
      assertEquals(m.headers?.get(DirectMsgHeaders.Stream), kv.bucketName());
    }
  })().then();

  await kv.put("hello", "world");
  await sub.closed;
  await cleanup(ns, nc);
});

Deno.test("kv - ttl is in nanos", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);

  const b = await new Kvm(js).create("a", { ttl: 1000 });
  const status = await b.status();
  assertEquals(status.ttl, 1000);
  assertEquals(status.size, 0);

  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.info("KV_a");
  assertEquals(si.config.max_age, nanos(1000));
  await cleanup(ns, nc);
});

Deno.test("kv - size", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);

  const b = await new Kvm(js).create("a", { ttl: 1000 });
  let status = await b.status();
  assertEquals(status.size, 0);
  assertEquals(status.size, status.streamInfo.state.bytes);

  await b.put("a", "hello");
  status = await b.status();
  assert(status.size > 0);
  assertEquals(status.size, status.streamInfo.state.bytes);
  await cleanup(ns, nc);
});

Deno.test(
  "kv - mirror cross domain",
  flakyTest(async () => {
    const { ns, nc } = await setup(
      jetstreamServerConf({
        server_name: "HUB",
        jetstream: { domain: "HUB" },
      }),
    );
    // the ports file doesn't report leaf node
    const varz = await ns.varz() as unknown;

    const { ns: lns, nc: lnc } = await setup(
      jetstreamServerConf({
        server_name: "LEAF",
        jetstream: { domain: "LEAF" },
        leafnodes: {
          remotes: [
            //@ts-ignore: direct query
            { url: `leaf://127.0.0.1:${varz.leaf.port}` },
          ],
        },
      }),
    );

    // setup a KV
    const js = jetstream(nc);
    const kv = await new Kvm(js).create("TEST");
    const m = new Map<string, KvEntry[]>();

    // watch notifications on a on "name"
    async function watch(kv: KV, bucket: string, key: string) {
      const iter = await kv.watch({ key });
      const buf: KvEntry[] = [];
      m.set(bucket, buf);

      return (async () => {
        for await (const e of iter) {
          buf.push(e);
        }
      })().then();
    }

    watch(kv, "test", "name").then();

    await kv.put("name", "derek");
    await kv.put("age", "22");
    await kv.put("v", "v");
    await kv.delete("v");
    await nc.flush();
    let a = m.get("test");
    assert(a);
    assertEquals(a.length, 1);
    assertEquals(a[0].string(), "derek");

    const ljs = jetstream(lnc);
    await new Kvm(ljs).create("MIRROR", {
      mirror: { name: "TEST", domain: "HUB" },
    });

    // setup a Mirror
    const ljsm = await jetstreamManager(lnc);
    let si = await ljsm.streams.info("KV_MIRROR");
    assertEquals(si.config.mirror_direct, true);

    for (let i = 0; i < 2000; i += 500) {
      si = await ljsm.streams.info("KV_MIRROR");
      if (si.state.messages === 3) {
        break;
      }
      await delay(500);
    }
    assertEquals(si.state.messages, 3);

    async function checkEntry(kv: KV, key: string, value: string, op: string) {
      const e = await kv.get(key);
      assert(e);
      assertEquals(e.operation, op);
      if (value !== "") {
        assertEquals(e.string(), value);
      }
    }

    async function t(kv: KV, name: string, old?: string) {
      const histIter = await kv.history();
      const hist: string[] = [];
      for await (const e of histIter) {
        hist.push(e.key);
      }

      if (old) {
        await checkEntry(kv, "name", old, "PUT");
        assertEquals(hist.length, 3);
        assertArrayIncludes(hist, ["name", "age", "v"]);
      } else {
        assertEquals(hist.length, 0);
      }

      await kv.put("name", name);
      await checkEntry(kv, "name", name, "PUT");

      await kv.put("v", "v");
      await checkEntry(kv, "v", "v", "PUT");

      await kv.delete("v");
      await checkEntry(kv, "v", "", "DEL");

      const keysIter = await kv.keys();
      const keys: string[] = [];
      for await (const k of keysIter) {
        keys.push(k);
      }
      assertEquals(keys.length, 2);
      assertArrayIncludes(keys, ["name", "age"]);
    }

    const mkv = await new Kvm(ljs).create("MIRROR");

    watch(mkv, "mirror", "name").then();
    await t(mkv, "rip", "derek");
    a = m.get("mirror");
    assert(a);
    assertEquals(a.length, 2);
    assertEquals(a[1].string(), "rip");

    // access the origin kv via the leafnode
    const rjs = jetstream(lnc, { domain: "HUB" });
    const rkv = await new Kvm(rjs).create("TEST") as Bucket;
    assertEquals(rkv.prefix, "$KV.TEST");
    watch(rkv, "origin", "name").then();
    await t(rkv, "ivan", "rip");
    await delay(1000);
    a = m.get("origin");
    assert(a);
    assertEquals(a.length, 2);
    assertEquals(a[1].string(), "ivan");

    // shutdown the server
    await cleanup(ns, nc);
    await checkEntry(mkv, "name", "ivan", "PUT");

    await cleanup(lns, lnc);
  }),
);

Deno.test("kv - previous sequence", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K");

  assertEquals(await kv.put("A", Empty, { previousSeq: 0 }), 1);
  assertEquals(await kv.put("B", Empty, { previousSeq: 0 }), 2);
  assertEquals(await kv.put("A", Empty, { previousSeq: 1 }), 3);
  assertEquals(await kv.put("A", Empty, { previousSeq: 3 }), 4);
  await assertRejects(async () => {
    await kv.put("A", Empty, { previousSeq: 1 });
  });
  assertEquals(await kv.put("B", Empty, { previousSeq: 2 }), 5);

  await cleanup(ns, nc);
});

Deno.test("kv - encoded entry", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K");
  await kv.put("a", "hello");
  await kv.put("b", JSON.stringify(5));
  await kv.put("c", JSON.stringify(["hello", 5]));

  assertEquals((await kv.get("a"))?.string(), "hello");
  assertEquals((await kv.get("b"))?.json(), 5);
  assertEquals((await kv.get("c"))?.json(), ["hello", 5]);

  await cleanup(ns, nc);
});

Deno.test("kv - create after delete", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K");
  await kv.create("a", Empty);

  await assertRejects(() => {
    return kv.create("a", Empty);
  });
  await kv.delete("a");
  await kv.create("a", Empty);
  await kv.purge("a");
  await kv.create("a", Empty);
  await cleanup(ns, nc);
});

Deno.test("kv - get non-existing non-direct", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K", { allow_direct: false });
  const v = await kv.get("hello");
  assertEquals(v, null);
  await cleanup(ns, nc);
});

Deno.test("kv - get non-existing direct", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K", { allow_direct: true });
  assertEquals(await kv.get("hello"), null);
  await cleanup(ns, nc);
});

Deno.test("kv - string payloads", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K");
  await kv.create("a", "b");
  let entry = await kv.get("a");
  assertExists(entry);
  assertEquals(entry?.string(), "b");

  await kv.put("a", "c");
  entry = await kv.get("a");
  assertExists(entry);
  assertEquals(entry?.string(), "c");

  await kv.update("a", "d", entry!.revision);
  entry = await kv.get("a");
  assertExists(entry);
  assertEquals(entry?.string(), "d");

  await cleanup(ns, nc);
});

Deno.test("kv - metadata", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K", { metadata: { hello: "world" } });
  const status = await kv.status();
  assertEquals(status.metadata?.hello, "world");
  await cleanup(ns, nc);
});

Deno.test("kv - watch updates only", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K");

  await kv.put("a", "a");
  await kv.put("b", "b");

  const iter = await kv.watch({
    include: KvWatchInclude.UpdatesOnly,
  });

  const notifications: KvWatchEntry[] = [];
  const done = (async () => {
    for await (const e of iter) {
      notifications.push(e);
      if (e.isUpdate) {
        break;
      }
    }
  })();
  await kv.put("c", "c");

  await done;
  assertEquals(notifications.length, 1);
  assertEquals(notifications[0].isUpdate, true);
  assertEquals(notifications[0].key, "c");

  await cleanup(ns, nc);
});

Deno.test("kv - watch multiple keys", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K");

  await kv.put("a", "a");
  await kv.put("b", "b");
  await kv.put("c", "c");

  const iter = await kv.watch({
    key: ["a", "c"],
  });

  const notifications: string[] = [];
  await (async () => {
    for await (const e of iter) {
      notifications.push(e.key);
      if (e.delta === 0) {
        break;
      }
    }
  })();

  assertEquals(notifications.length, 2);
  assertArrayIncludes(notifications, ["a", "c"]);

  await cleanup(ns, nc);
});

Deno.test("kv - watch history", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K", { history: 10 });

  await kv.put("a", "a");
  await kv.put("a", "aa");
  await kv.put("a", "aaa");
  await kv.delete("a");

  const iter = await kv.watch({
    include: KvWatchInclude.AllHistory,
  });

  const notifications: string[] = [];
  (async () => {
    for await (const e of iter) {
      if (e.operation === "DEL") {
        notifications.push(`${e.key}=del`);
      } else {
        notifications.push(`${e.key}=${e.string()}`);
      }
    }
  })().then();
  await kv.put("c", "c");
  await delay(1000);

  assertEquals(notifications.length, 5);
  assertEquals(notifications[0], "a=a");
  assertEquals(notifications[1], "a=aa");
  assertEquals(notifications[2], "a=aaa");
  assertEquals(notifications[3], "a=del");
  assertEquals(notifications[4], "c=c");

  await cleanup(ns, nc);
});

Deno.test("kv - watch history no deletes", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const js = jetstream(nc);
  const kv = await new Kvm(js).create("K", { history: 10 });

  await kv.put("a", "a");
  await kv.put("a", "aa");
  await kv.put("a", "aaa");
  await kv.delete("a");

  const iter = await kv.watch({
    include: KvWatchInclude.AllHistory,
    ignoreDeletes: true,
  });

  const notifications: string[] = [];
  (async () => {
    for await (const e of iter) {
      if (e.operation === "DEL") {
        notifications.push(`${e.key}=del`);
      } else {
        notifications.push(`${e.key}=${e.string()}`);
      }
    }
  })().then();
  await kv.put("c", "c");
  await kv.delete("c");
  await delay(1000);

  assertEquals(notifications.length, 4);
  assertEquals(notifications[0], "a=a");
  assertEquals(notifications[1], "a=aa");
  assertEquals(notifications[2], "a=aaa");
  assertEquals(notifications[3], "c=c");

  await cleanup(ns, nc);
});

Deno.test("kv - republish header handling", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  const n = nuid.next();
  await jsm.streams.add({
    name: n,
    subjects: ["A.>"],
    storage: StorageType.Memory,
    republish: {
      src: ">",
      dest: `$KV.${n}.>`,
    },
  });

  const js = jetstream(nc);
  const kv = await new Kvm(js).create(n);

  nc.publish("A.orange", "hey");
  await js.publish("A.tomato", "hello");
  await kv.put("A.potato", "yo");

  async function check(allow_direct = false): Promise<void> {
    const B = await new Kvm(js).create(n, { allow_direct });
    let e = await B.get("A.orange");
    assertExists(e);

    e = await B.get("A.tomato");
    assertExists(e);

    e = await B.get("A.potato");
    assertExists(e);
  }
  await check();
  await check(true);

  await cleanup(ns, nc);
});

Deno.test("kv - compression", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);
  const s2 = await new Kvm(js).create("compressed", {
    compression: true,
  });
  let status = await s2.status();
  assertEquals(status.compression, true);

  const none = await new Kvm(js).create("none");
  status = await none.status();
  assertEquals(status.compression, false);
  await cleanup(ns, nc);
});

Deno.test("kv - watch start at", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = jetstream(nc);
  const kv = await new Kvm(js).create("a");
  await kv.put("a", "1");
  await kv.put("b", "2");
  await kv.put("c", "3");

  const iter = await kv.watch({ resumeFromRevision: 2 });
  await (async () => {
    for await (const o of iter) {
      // expect first key to be "b"
      assertEquals(o.key, "b");
      assertEquals(o.revision, 2);
      break;
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("kv - delete key if revision", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next());
  const seq = await b.create("a", Empty);
  await assertRejects(
    async () => {
      await b.delete("a", { previousSeq: 100 });
    },
    Error,
    "wrong last sequence: 1",
    undefined,
  );

  await b.delete("a", { previousSeq: seq });

  await cleanup(ns, nc);
});

Deno.test("kv - purge key if revision", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  const b = await new Kvm(js).create(nuid.next());
  const seq = await b.create("a", Empty);

  await assertRejects(
    async () => {
      await b.purge("a", { previousSeq: 2 });
    },
    Error,
    "wrong last sequence: 1",
    undefined,
  );

  await b.purge("a", { previousSeq: seq });
  await cleanup(ns, nc);
});

Deno.test("kv - bind no info", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const js = jetstream(nc);
  await new Kvm(js).create("A");

  const d = deferred();
  nc.subscribe("$JS.API.STREAM.INFO.>", {
    callback: () => {
      d.reject(new Error("saw stream info"));
    },
  });

  const kv = await new Kvm(js).create("A", {
    bindOnly: true,
    allow_direct: true,
  });
  await kv.put("a", "hello");
  const e = await kv.get("a");
  assertEquals(e?.string(), "hello");
  await kv.delete("a");

  d.resolve();
  // shouldn't have rejected earlier
  await d;

  await cleanup(ns, nc);
});

Deno.test("kv - watcher will name and filter", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const js = jetstream(nc);
  const kv = await new Kvm(js).create("A");

  const sub = syncIterator(nc.subscribe("$JS.API.>"));
  const iter = await kv.watch({ key: "a.>" });

  const m = await sub.next();
  assert(m?.subject.startsWith("$JS.API.CONSUMER.CREATE.KV_A."));
  assert(m?.subject.endsWith("$KV.A.a.>"));

  iter.stop();

  await cleanup(ns, nc);
});

Deno.test("kv - honors checkAPI option", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);
  const sub = nc.subscribe("$JS.API.INFO");
  const si = syncIterator(sub);
  await new Kvm(js).create("A");
  assertExists(await si.next());

  const js2 = jetstream(nc, { checkAPI: false });
  await new Kvm(js2).create("B");
  await sub.drain();
  assertEquals(await si.next(), null);

  await cleanup(ns, nc);
});

Deno.test("kv - watcher on server restart", async () => {
  let { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc);
  const kv = await new Kvm(js).create("A");
  const iter = await kv.watch();
  const d = deferred<KvEntry>();
  (async () => {
    for await (const e of iter) {
      d.resolve(e);
      break;
    }
  })().then();

  ns = await ns.restart();
  for (let i = 0; i < 10; i++) {
    try {
      await kv.put("hello", "world");
      break;
    } catch {
      await delay(500);
    }
  }

  await d;
  await cleanup(ns, nc);
});

Deno.test("kv - kv rejects in older servers", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      max_payload: 1024 * 1024,
    }),
  );

  const nci = nc as NatsConnectionImpl;
  const js = jetstream(nc);
  async function t(version: string, ok: boolean): Promise<void> {
    nci.features.update(version);

    if (!ok) {
      await assertRejects(
        async () => {
          await new Kvm(js).create(nuid.next());
        },
        Error,
        `kv is only supported on servers 2.6.2 or better`,
      );
    } else {
      await new Kvm(js).create(nuid.next());
    }
  }

  await t("2.6.1", false);
  await t("2.6.2", true);
  await cleanup(ns, nc);
});

Deno.test("kv - maxBucketSize doesn't override max_bytes", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({}),
  );
  const kvm = new Kvm(nc);
  const kv = await kvm.create("A", { max_bytes: 100 });
  const info = await kv.status();
  assertEquals(info.max_bytes, 100);
  await cleanup(ns, nc);
});

Deno.test("kv - keys filter", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({}),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const kvm = new Kvm(nc);
  const b = await kvm.create(nuid.next());
  await Promise.all([b.put("A", "a"), b.put("B", "b"), b.put("C", "c")]);

  const buf = [];
  for await (const e of await b.keys()) {
    buf.push(e);
  }
  assertEquals(buf.length, 3);
  assertArrayIncludes(buf, ["A", "B", "C"]);

  buf.length = 0;
  for await (const e of await b.keys("A")) {
    buf.push(e);
  }
  assertEquals(buf.length, 1);
  assertArrayIncludes(buf, ["A"]);

  buf.length = 0;
  for await (const e of await b.keys(["A", "C"])) {
    buf.push(e);
  }
  assertEquals(buf.length, 2);
  assertArrayIncludes(buf, ["A", "C"]);

  await cleanup(ns, nc);
});

Deno.test("kv - replicas", async () => {
  const servers = await NatsServer.jetstreamCluster(3);
  const nc = await connect({ port: servers[0].port });
  const js = jetstream(nc);

  const b = await new Kvm(js).create("a", { replicas: 3 });
  const status = await b.status();

  const jsm = await jetstreamManager(nc);
  let si = await jsm.streams.info(status.streamInfo.config.name);
  assertEquals(si.config.num_replicas, 3);

  si = await jsm.streams.update(status.streamInfo.config.name, {
    num_replicas: 1,
  });
  assertEquals(si.config.num_replicas, 1);

  await nc.close();
  await NatsServer.stopAll(servers, true);
});

Deno.test("kv - sourced", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({}),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const js = jetstream(nc);
  const kvm = await new Kvm(js);
  const source = await kvm.create("source");
  const target = await kvm.create("target", {
    sources: [{ name: "source" }],
  });

  await source.put("hello", "world");
  for (let i = 0; i < 10; i++) {
    const v = await target.get("hello");
    if (v === null) {
      await delay(250);
      continue;
    }
    assertEquals(v.string(), "world");
  }

  await cleanup(ns, nc);
});

Deno.test("kv - watch isUpdate", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({}),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const js = jetstream(nc);
  const kvm = await new Kvm(js);
  const kv = await kvm.create("A");
  await kv.put("a", "hello");
  await kv.delete("a");

  const iter = await kv.watch({ ignoreDeletes: true });
  const done = (async () => {
    for await (const e of iter) {
      if (e.key === "b") {
        assertEquals(e.isUpdate, true);
        break;
      }
    }
  })();
  await kv.put("b", "hello");

  await done;

  await cleanup(ns, nc);
});

Deno.test("kv - kv - bind doesn't check jetstream", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const apiInfo = nc.subscribe("$JS.API.INFO", {
    callback: (_, m) => {
      console.log(m.subject);
    },
  });

  const streamInfo = nc.subscribe("$JS.API.STREAM.INFO.*", {
    callback: (_, m) => {
      console.log(m.subject);
    },
  });

  let kvm = new Kvm(jetstream(nc, { checkAPI: false }));

  await kvm.create("A", { bindOnly: true });
  assertEquals(apiInfo.getReceived(), 0);
  assertEquals(streamInfo.getReceived(), 0);

  await kvm.open("A", { bindOnly: true });
  assertEquals(apiInfo.getReceived(), 0);
  assertEquals(streamInfo.getReceived(), 0);

  kvm = new Kvm(jetstream(nc));
  await kvm.create("B", { bindOnly: true });
  assertEquals(apiInfo.getReceived(), 0);
  assertEquals(streamInfo.getReceived(), 0);

  kvm = new Kvm(jetstream(nc));
  await kvm.create("B");
  assertEquals(apiInfo.getReceived(), 1);
  assertEquals(streamInfo.getReceived(), 1);

  await cleanup(ns, nc);
});
