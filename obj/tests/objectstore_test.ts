/*
 * Copyright 2022-2025 The NATS Authors
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
  cleanup,
  connect,
  jetstreamServerConf,
  NatsServer,
  notCompatible,
  setup,
} from "nst";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  equal,
} from "@std/assert";
import {
  DataBuffer,
  Empty,
  headers,
  nanos,
  nuid,
  type QueuedIteratorImpl,
} from "@nats-io/nats-core/internal";
import type { NatsConnectionImpl } from "@nats-io/nats-core/internal";
import type {
  ObjectInfo,
  ObjectStoreMeta,
  ObjectWatchInfo,
} from "../src/types.ts";
import {
  DiscardPolicy,
  jetstream,
  jetstreamManager,
  type PushConsumer,
  StorageType,
} from "@nats-io/jetstream/internal";
import { equals } from "@std/bytes";
import { digestType, type ObjectStoreImpl, Objm } from "../src/objectstore.ts";
import { Base64UrlPaddedCodec } from "../src/base64.ts";
import { setSha256Backend } from "../src/sha256.ts";
import { sha256 } from "js-sha256";

function readableStreamFrom(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

async function fromReadableStream(
  rs: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const buf = new DataBuffer();
  const reader = rs.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return buf.drain();
    }
    if (value && value.length) {
      buf.fill(value);
    }
  }
}

function makeData(n: number): Uint8Array {
  const data = new Uint8Array(n);
  let index = 0;
  let bytes = n;
  while (true) {
    if (bytes === 0) {
      break;
    }
    const len = bytes > 65536 ? 65536 : bytes;
    bytes -= len;
    const buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    data.set(buf, index);
    index += buf.length;
  }
  return data;
}

function digest(data: Uint8Array): string {
  const sha = sha256.create();
  sha.update(data);
  const digest = Base64UrlPaddedCodec.encode(Uint8Array.from(sha.digest()));
  return `${digestType}${digest}`;
}

Deno.test("objectstore - list stores", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "A", subjects: ["a"] });

  const objm = new Objm(nc);
  let stores = await objm.list().next();
  assertEquals(stores.length, 0);

  await objm.create("store1");
  stores = await objm.list().next();
  assertEquals(stores.length, 1);
  assertEquals(stores[0].bucket, "store1");

  await objm.create("store2");
  stores = await objm.list().next();
  assertEquals(stores.length, 2);

  const names = stores.map((s) => s.bucket).sort();
  assertEquals(names, ["store1", "store2"]);

  await cleanup(ns, nc);
});

Deno.test("objectstore - basics", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const blob = new Uint8Array(65536);
  crypto.getRandomValues(blob);

  const objm = new Objm(nc);
  const os = await objm.create("OBJS", { description: "testing" });

  const info = await os.status();
  assertEquals(info.description, "testing");
  assertEquals(info.ttl, 0);
  assertEquals(info.replicas, 1);
  assertEquals(info.streamInfo.config.name, "OBJ_OBJS");

  const oi = await os.put(
    { name: "BLOB", description: "myblob" },
    readableStreamFrom(blob),
  );
  assertEquals(oi.bucket, "OBJS");
  assertEquals(oi.nuid.length, 22);
  assertEquals(oi.name, "BLOB");
  assertEquals(oi.digest, digest(blob));
  assertEquals(oi.description, "myblob");
  assertEquals(oi.deleted, false);
  assert(typeof oi.mtime === "string");

  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.info("OBJ_OBJS");
  assertExists(si);

  const osi = await os.seal();
  assertEquals(osi.sealed, true);
  assert(osi.size > blob.length);
  assertEquals(osi.storage, StorageType.File);
  assertEquals(osi.description, "testing");

  let or = await os.get("foo");
  assertEquals(or, null);

  or = await os.get("BLOB");
  assertExists(or);
  const read = await fromReadableStream(or!.data);
  equal(read, blob);

  assertEquals(await os.destroy(), true);
  await assertRejects(
    async () => {
      await jsm.streams.info("OBJ_OBJS");
    },
    Error,
    "stream not found",
  );

  await cleanup(ns, nc);
});

Deno.test("objectstore - default status", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test", { description: "testing" });
  const blob = new Uint8Array(65536);
  crypto.getRandomValues(blob);
  await os.put({ name: "BLOB" }, readableStreamFrom(blob));

  const status = await os.status();
  assertEquals(status.backingStore, "JetStream");
  assertEquals(status.bucket, "test");
  assertEquals(status.streamInfo.config.name, "OBJ_test");

  await cleanup(ns, nc);
});

Deno.test("objectstore - chunked content", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        max_memory_store: 10 * 1024 * 1024 + 33,
      },
    }),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test", { storage: StorageType.Memory });

  const data = makeData(nc.info!.max_payload * 3);
  await os.put(
    { name: "blob", options: { max_chunk_size: nc.info!.max_payload } },
    readableStreamFrom(data),
  );

  const d = await os.get("blob");
  assertEquals(d!.info.digest, digest(data));
  const vv = await fromReadableStream(d!.data);
  equals(vv, data);

  await cleanup(ns, nc);
});

Deno.test("objectstore - multi content", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test", { storage: StorageType.Memory });

  const a = makeData(128);
  await os.put(
    { name: "a.js", options: { max_chunk_size: 1 } },
    readableStreamFrom(a),
  );
  const b = new TextEncoder().encode("hello world from object store");
  await os.put(
    { name: "b.js", options: { max_chunk_size: nc.info!.max_payload } },
    readableStreamFrom(b),
  );

  let d = await os.get("a.js");
  let vv = await fromReadableStream(d!.data);
  equals(vv, a);

  d = await os.get("b.js");
  vv = await fromReadableStream(d!.data);
  equals(vv, b);

  await cleanup(ns, nc);
});

Deno.test("objectstore - delete markers", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test", { storage: StorageType.Memory });

  const a = makeData(128);
  await os.put(
    { name: "a", options: { max_chunk_size: 10 } },
    readableStreamFrom(a),
  );

  const p = await os.delete("a");
  assertEquals(p.purged, 13);

  const info = await os.info("a");
  assertExists(info);
  assertEquals(info!.deleted, true);

  await cleanup(ns, nc);
});

Deno.test("objectstore - get on deleted returns error", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test", { storage: StorageType.Memory });

  const a = makeData(128);
  await os.put(
    { name: "a", options: { max_chunk_size: 10 } },
    readableStreamFrom(a),
  );

  const p = await os.delete("a");
  assertEquals(p.purged, 13);

  const info = await os.info("a");
  assertExists(info);
  assertEquals(info!.deleted, true);

  const r = await os.get("a");
  assertEquals(r, null);

  await cleanup(ns, nc);
});

Deno.test("objectstore - multi with delete", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test", { storage: StorageType.Memory });

  await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("a!")),
  );

  const si = await os.status({ subjects_filter: ">" });
  await os.put(
    { name: "b", options: { max_chunk_size: nc.info!.max_payload } },
    readableStreamFrom(new TextEncoder().encode("b!")),
  );

  await os.get("b");
  await os.delete("b");

  const s2 = await os.status({ subjects_filter: ">" });
  // should have the tumbstone for the deleted subject
  assertEquals(s2.streamInfo.state.messages, si.streamInfo.state.messages + 1);

  await cleanup(ns, nc);
});

Deno.test("objectstore - object names", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test", { storage: StorageType.Memory });
  await os.put(
    { name: "blob.txt" },
    readableStreamFrom(new TextEncoder().encode("A")),
  );
  await os.put(
    { name: "foo bar" },
    readableStreamFrom(new TextEncoder().encode("A")),
  );
  await os.put(
    { name: " " },
    readableStreamFrom(new TextEncoder().encode("A")),
  );
  await os.put(
    { name: "*" },
    readableStreamFrom(new TextEncoder().encode("A")),
  );
  await os.put(
    { name: ">" },
    readableStreamFrom(new TextEncoder().encode("A")),
  );
  await assertRejects(async () => {
    await os.put(
      { name: "" },
      readableStreamFrom(new TextEncoder().encode("A")),
    );
  });
  await cleanup(ns, nc);
});

Deno.test("objectstore - metadata", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test", { storage: StorageType.Memory });

  await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("A")),
  );

  // rename a
  let meta = { name: "b" } as ObjectStoreMeta;
  await os.update("a", meta);
  let info = await os.info("b");
  assertExists(info);
  assertEquals(info!.name, "b");

  // add some headers
  meta = {} as ObjectStoreMeta;
  meta.headers = headers();
  meta.headers.set("color", "red");
  await os.update("b", meta);

  info = await os.info("b");
  assertExists(info);
  assertEquals(info!.headers?.get("color"), "red");

  await cleanup(ns, nc);
});

Deno.test("objectstore - empty entry", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("empty");

  const oi = await os.put(
    { name: "empty" },
    readableStreamFrom(new Uint8Array(0)),
  );
  assertEquals(oi.nuid.length, 22);
  assertEquals(oi.name, "empty");
  assertEquals(oi.digest, digest(new Uint8Array(0)));
  assertEquals(oi.chunks, 0);

  const or = await os.get("empty");
  assert(or !== null);
  assertEquals(await or.error, null);
  const v = await fromReadableStream(or.data);
  assertEquals(v.length, 0);

  await cleanup(ns, nc);
});

Deno.test("objectstore - list", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");
  let infos = await os.list();
  assertEquals(infos.length, 0);

  await os.put(
    { name: "a" },
    readableStreamFrom(new Uint8Array(0)),
  );

  infos = await os.list();
  assertEquals(infos.length, 1);
  assertEquals(infos[0].name, "a");

  await cleanup(ns, nc);
});

Deno.test("objectstore - list no updates", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  let infos = await os.list();
  assertEquals(infos.length, 0);

  await os.put({ name: "a" }, readableStreamFrom(new Uint8Array(0)));
  infos = await os.list();
  assertEquals(infos.length, 1);

  await cleanup(ns, nc);
});

Deno.test("objectstore - watch isUpdate", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");
  await os.put({ name: "a" }, readableStreamFrom(new Uint8Array(0)));

  const watches = await os.watch();
  await os.put({ name: "b" }, readableStreamFrom(new Uint8Array(0)));

  for await (const e of watches) {
    if (e.name === "b") {
      assertEquals(e.isUpdate, true);
      break;
    } else {
      assertEquals(e.isUpdate, false);
    }
  }

  await cleanup(ns, nc);
});

Deno.test("objectstore - watch initially empty", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  const buf: ObjectInfo[] = [];
  const iter = await os.watch({ includeHistory: true });
  const done = (async () => {
    for await (const info of iter) {
      if (info === null) {
        assertEquals(buf.length, 0);
      } else {
        buf.push(info);
        if (buf.length === 3) {
          break;
        }
      }
    }
  })();
  const infos = await os.list();
  assertEquals(infos.length, 0);

  await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("a")),
  );

  await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("aa")),
  );

  await os.put(
    { name: "b" },
    readableStreamFrom(new TextEncoder().encode("b")),
  );

  await done;

  assertEquals(buf.length, 3);
  assertEquals(buf[0].name, "a");
  assertEquals(buf[0].size, 1);
  assertEquals(buf[1].name, "a");
  assertEquals(buf[1].size, 2);
  assertEquals(buf[2].name, "b");
  assertEquals(buf[2].size, 1);

  await cleanup(ns, nc);
});

Deno.test("objectstore - watch skip history", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("a")),
  );

  await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("aa")),
  );

  const buf: ObjectInfo[] = [];
  const iter = await os.watch({ includeHistory: false });
  const done = (async () => {
    for await (const info of iter) {
      if (info === null) {
        assertEquals(buf.length, 1);
      } else {
        buf.push(info);
        if (buf.length === 1) {
          break;
        }
      }
    }
  })();

  await os.put(
    { name: "c" },
    readableStreamFrom(new TextEncoder().encode("c")),
  );

  await done;

  assertEquals(buf.length, 1);
  assertEquals(buf[0].name, "c");
  assertEquals(buf[0].size, 1);

  await cleanup(ns, nc);
});

Deno.test("objectstore - watch history", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("a")),
  );

  await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("aa")),
  );

  const buf: ObjectInfo[] = [];
  const iter = await os.watch({ includeHistory: true });
  const done = (async () => {
    for await (const info of iter) {
      if (info === null) {
        assertEquals(buf.length, 1);
      } else {
        buf.push(info);
        if (buf.length === 2) {
          break;
        }
      }
    }
  })();

  await os.put(
    { name: "c" },
    readableStreamFrom(new TextEncoder().encode("c")),
  );

  await done;

  assertEquals(buf.length, 2);
  assertEquals(buf[0].name, "a");
  assertEquals(buf[0].size, 2);
  assertEquals(buf[1].name, "c");
  assertEquals(buf[1].size, 1);

  await cleanup(ns, nc);
});

Deno.test("objectstore - same store link", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  const src = await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("a")),
  );
  const oi = await os.link("ref", src);
  assertEquals(oi.options?.link?.bucket, src.bucket);
  assertEquals(oi.options?.link?.name, "a");

  const a = await os.list();
  assertEquals(a.length, 2);
  assertEquals(a[0].name, "a");
  assertEquals(a[1].name, "ref");

  const data = await os.getBlob("ref");
  assertEquals(new TextDecoder().decode(data!), "a");

  await cleanup(ns, nc);
});

Deno.test("objectstore - link of link rejected", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  const src = await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("a")),
  );
  const link = await os.link("ref", src);

  await assertRejects(
    async () => {
      await os.link("ref2", link);
    },
    Error,
    "src object is a link",
  );

  await cleanup(ns, nc);
});

Deno.test("objectstore - external link", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  const src = await os.put(
    { name: "a" },
    readableStreamFrom(new TextEncoder().encode("a")),
  );

  const os2 = await objm.create("another");
  const io = await os2.link("ref", src);
  assertExists(io.options?.link);
  assertEquals(io.options?.link?.bucket, "test");
  assertEquals(io.options?.link?.name, "a");

  const data = await os2.getBlob("ref");
  assertEquals(new TextDecoder().decode(data!), "a");

  await cleanup(ns, nc);
});

Deno.test("objectstore - store link", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  const os2 = await objm.create("another");
  const si = await os2.linkStore("src", os);
  assertExists(si.options?.link);
  assertEquals(si.options?.link?.bucket, "test");

  await cleanup(ns, nc);
});

Deno.test("objectstore - max chunk is max payload", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      max_payload: 8 * 1024,
    }),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  assertEquals(nc.info?.max_payload, 8 * 1024);

  const objm = new Objm(nc);
  const os = await objm.create("test");

  const rs = readableStreamFrom(makeData(32 * 1024));

  const info = await os.put({ name: "t" }, rs);
  assertEquals(info.size, 32 * 1024);
  assertEquals(info.chunks, 4);
  assertEquals(info.options?.max_chunk_size, 8 * 1024);

  await cleanup(ns, nc);
});

Deno.test("objectstore - default chunk is 128k", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      max_payload: 1024 * 1024,
    }),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  assertEquals(nc.info?.max_payload, 1024 * 1024);

  const objm = new Objm(nc);
  const os = await objm.create("test");

  const rs = readableStreamFrom(makeData(129 * 1024));

  const info = await os.put({ name: "t" }, rs);
  assertEquals(info.size, 129 * 1024);
  assertEquals(info.chunks, 2);
  assertEquals(info.options?.max_chunk_size, 128 * 1024);

  await cleanup(ns, nc);
});

Deno.test("objectstore - sanitize", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      max_payload: 1024 * 1024,
    }),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");
  await os.put({ name: "has.dots.here" }, readableStreamFrom(makeData(1)));
  await os.put(
    { name: "the spaces are here" },
    readableStreamFrom(makeData(1)),
  );

  const info = await os.status({
    subjects_filter: ">",
  });
  const subjects = info.streamInfo.state?.subjects || {};
  assertEquals(
    subjects[`$O.test.M.${Base64UrlPaddedCodec.encode("has.dots.here")}`],
    1,
  );
  assertEquals(
    subjects[
      `$O.test.M.${Base64UrlPaddedCodec.encode("the spaces are here")}`
    ],
    1,
  );

  await cleanup(ns, nc);
});

Deno.test("objectstore - partials", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      max_payload: 1024 * 1024,
    }),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  const data = new TextEncoder().encode("".padStart(7, "a"));

  const info = await os.put(
    { name: "test", options: { max_chunk_size: 2 } },
    readableStreamFrom(data),
  );
  assertEquals(info.chunks, 4);
  assertEquals(info.digest, digest(data));

  const rs = await os.get("test");
  const reader = rs!.data.getReader();
  let i = 0;
  while (true) {
    i++;
    const { done, value } = await reader.read();
    if (done) {
      assertEquals(i, 5);
      break;
    }
    if (i === 4) {
      assertEquals(value!.length, 1);
    } else {
      assertEquals(value!.length, 2);
    }
  }
  await cleanup(ns, nc);
});

Deno.test("objectstore - no store", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      max_payload: 1024 * 1024,
    }),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");
  await os.put({ name: "test" }, readableStreamFrom(Empty));
  await os.delete("test");
  const oi = await os.info("test");
  await assertRejects(
    async () => {
      await os.link("bar", oi!);
    },
    Error,
    "object is deleted",
  );

  const r = await os.delete("foo");
  assertEquals(r, { purged: 0, success: false });

  await assertRejects(
    async () => {
      await os.update("baz", oi!);
    },
    Error,
    "object not found",
  );

  const jsm = await jetstreamManager(nc);
  await jsm.streams.delete("OBJ_test");
  await assertRejects(
    async () => {
      await os.seal();
    },
    Error,
    "object store not found",
  );

  await assertRejects(
    async () => {
      await os.status();
    },
    Error,
    "object store not found",
  );

  await assertRejects(
    async () => {
      await os.put({ name: "foo" }, readableStreamFrom(Empty));
    },
    Error,
    "stream not found",
  );

  await cleanup(ns, nc);
});

Deno.test("objectstore - hashtests", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      max_payload: 1024 * 1024,
    }),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("hashes");

  const base =
    "https://raw.githubusercontent.com/nats-io/nats.client.deps/main/digester_test/";
  const tests: { hash: string; file: string }[] = [{
    hash: "IdgP4UYMGt47rgecOqFoLrd24AXukHf5-SVzqQ5Psg8=",
    file: "digester_test_bytes_000100.txt",
  }, {
    hash: "DZj4RnBpuEukzFIY0ueZ-xjnHY4Rt9XWn4Dh8nkNfnI=",
    file: "digester_test_bytes_001000.txt",
  }, {
    hash: "RgaJ-VSJtjNvgXcujCKIvaheiX_6GRCcfdRYnAcVy38=",
    file: "digester_test_bytes_010000.txt",
  }, {
    hash: "yan7pwBVnC1yORqqgBfd64_qAw6q9fNA60_KRiMMooE=",
    file: "digester_test_bytes_100000.txt",
  }];

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    const r = await fetch(`${base}${t.file}`);
    const rs = await r.blob();

    const oi = await os.put(
      { name: t.hash, options: { max_chunk_size: 9 } },
      rs.stream(),
      { timeout: 20_000 },
    );
    assertEquals(oi.digest, `${digestType}${t.hash}`);
  }

  await cleanup(ns, nc);
});

Deno.test("objectstore - meta update", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      max_payload: 1024 * 1024,
    }),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  // cannot update meta of an object that doesn't exist
  await assertRejects(
    async () => {
      await os.update("A", { name: "B" });
    },
    Error,
    "object not found",
  );

  // cannot update the meta of a deleted object
  await os.put({ name: "D" }, readableStreamFrom(makeData(1)));
  await os.delete("D");
  await assertRejects(
    async () => {
      await os.update("D", { name: "DD" });
    },
    Error,
    "cannot update meta for a deleted object",
  );

  // cannot update the meta to an object that already exists
  await os.put({ name: "A" }, readableStreamFrom(makeData(1)));
  await os.put({ name: "B" }, readableStreamFrom(makeData(1)));

  await assertRejects(
    async () => {
      await os.update("A", { name: "B" });
    },
    Error,
    "an object already exists with that name",
  );

  await cleanup(ns, nc);
});

Deno.test("objectstore - cannot put links", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      max_payload: 1024 * 1024,
    }),
  );
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("test");

  const link = { bucket: "test", name: "a" };
  const mm = {
    name: "ref",
    options: { link: link },
  } as ObjectStoreMeta;

  await assertRejects(
    async () => {
      await os.put(mm, readableStreamFrom(new TextEncoder().encode("a")));
    },
    Error,
    "link cannot be set when putting the object in bucket",
  );

  await cleanup(ns, nc);
});

Deno.test("objectstore - put purges old entries", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const objm = new Objm(nc);
  const os = await objm.create("OBJS", { description: "testing" });

  // we expect 10 messages per put
  const t = async (first: number, last: number) => {
    const status = await os.status();
    const si = status.streamInfo;
    assertEquals(si.state.first_seq, first);
    assertEquals(si.state.last_seq, last);
  };

  const blob = new Uint8Array(9);
  let oi = await os.put(
    { name: "BLOB", description: "myblob", options: { max_chunk_size: 1 } },
    readableStreamFrom(crypto.getRandomValues(blob)),
  );
  assertEquals(oi.revision, 10);
  await t(1, 10);

  oi = await os.put(
    { name: "BLOB", description: "myblob", options: { max_chunk_size: 1 } },
    readableStreamFrom(crypto.getRandomValues(blob)),
  );
  assertEquals(oi.revision, 20);
  await t(11, 20);
  await cleanup(ns, nc);
});

Deno.test("objectstore - put previous sequences", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const objm = new Objm(nc);
  const os = await objm.create("OBJS", { description: "testing" });

  // putting the first
  let oi = await os.put(
    { name: "A", options: { max_chunk_size: 1 } },
    readableStreamFrom(crypto.getRandomValues(new Uint8Array(9))),
    { previousRevision: 0 },
  );
  assertEquals(oi.revision, 10);

  // putting another value, but the first value for the key - so previousRevision is 0
  oi = await os.put(
    { name: "B", options: { max_chunk_size: 1 } },
    readableStreamFrom(crypto.getRandomValues(new Uint8Array(3))),
    { previousRevision: 0 },
  );
  assertEquals(oi.revision, 14);

  // update A, previous A is found at 10
  oi = await os.put(
    { name: "A", options: { max_chunk_size: 1 } },
    readableStreamFrom(crypto.getRandomValues(new Uint8Array(3))),
    { previousRevision: 10 },
  );
  assertEquals(oi.revision, 18);

  // update A, previous A is found at 18
  oi = await os.put(
    { name: "A", options: { max_chunk_size: 1 } },
    readableStreamFrom(Empty),
    { previousRevision: 18 },
  );
  assertEquals(oi.revision, 19);

  await cleanup(ns, nc);
});

Deno.test("objectstore - put/get blob", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("OBJS", { description: "testing" });

  const payload = new Uint8Array(9);

  // putting the first
  await os.put(
    { name: "A", options: { max_chunk_size: 1 } },
    readableStreamFrom(payload),
    { previousRevision: 0 },
  );

  let bg = await os.getBlob("A");
  assertExists(bg);
  assertEquals(bg.length, payload.length);
  assertEquals(bg, payload);

  await os.putBlob({ name: "B", options: { max_chunk_size: 1 } }, payload);

  bg = await os.getBlob("B");
  assertExists(bg);
  assertEquals(bg.length, payload.length);
  assertEquals(bg, payload);

  await cleanup(ns, nc);
});

Deno.test("objectstore - ttl", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const ttl = nanos(60 * 1000);
  const os = await objm.create("OBJS", { ttl });
  const status = await os.status();
  assertEquals(status.ttl, ttl);

  await cleanup(ns, nc);
});

Deno.test("objectstore - allow direct", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const objm = new Objm(nc);
  const os = await objm.create("OBJS");
  const status = await os.status();
  assertEquals(status.streamInfo.config.allow_direct, true);

  await cleanup(ns, nc);
});

Deno.test("objectstore - stream metadata and entry metadata", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }

  const objm = new Objm(nc);
  const os = await objm.create("OBJS", {
    description: "testing",
    metadata: { hello: "world" },
  });

  const status = await os.status();
  assertEquals(status.metadata?.hello, "world");

  const info = await os.putBlob(
    { name: "hello", metadata: { world: "hello" } },
    Empty,
  );
  assertEquals(info.metadata?.world, "hello");

  const hi = await os.info("hello");
  assertExists(hi);
  assertEquals(hi.metadata?.world, "hello");

  await cleanup(ns, nc);
});

Deno.test("os - compression", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const objm = new Objm(nc);
  const s2 = await objm.create("compressed", {
    compression: true,
  });
  let status = await s2.status();
  assertEquals(status.compression, true);

  const none = await objm.create("none");
  status = await none.status();
  assertEquals(status.compression, false);
  await cleanup(ns, nc);
});

Deno.test("os - os rejects in older servers", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      max_payload: 1024 * 1024,
    }),
  );

  const nci = nc as NatsConnectionImpl;
  const objm = new Objm(nc);

  async function t(version: string, ok: boolean): Promise<void> {
    nci.features.update(version);

    if (!ok) {
      await assertRejects(
        async () => {
          await objm.create(nuid.next());
        },
        Error,
        `objectstore is only supported on servers 2.6.3 or better`,
      );
    } else {
      await objm.create(nuid.next());
    }
  }

  await t("2.6.2", false);
  await t("2.6.3", true);
  await cleanup(ns, nc);
});

Deno.test("os - objm open", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));

  const objm = new Objm(nc);
  await assertRejects(
    () => {
      return objm.open("hello");
    },
    Error,
    "object store not found",
  );

  let obj = await objm.open("hello", false);

  await assertRejects(
    () => {
      return obj.get("hello");
    },
    Error,
    "stream not found",
  );

  await assertRejects(
    () => {
      return obj.put({ name: "hi" }, readableStreamFrom(Empty));
    },
    Error,
    "stream not found",
  );

  await objm.create("hello");

  obj = await objm.open("hello");
  const oi = await obj.put({ name: "hello" }, readableStreamFrom(Empty));
  assertEquals(oi.name, "hello");

  await cleanup(ns, nc);
});

Deno.test("os - objm creates right number of replicas", async () => {
  const servers = await NatsServer.jetstreamCluster(3);
  const nc = await connect({ port: servers[0].port });
  const objm = new Objm(nc);

  const obj = await objm.create("test", { replicas: 3 });
  const status = await obj.status();
  assertEquals(status.replicas, 3);

  await nc.close();
  await NatsServer.stopAll(servers, true);
});

Deno.test("objectstore - get detects corrupt digest", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }

  const objm = new Objm(nc);
  const os = await objm.create("test", { storage: StorageType.Memory });

  const data = new TextEncoder().encode("hello world");
  await os.put(
    { name: "corrupt" },
    readableStreamFrom(data),
  );

  // overwrite the metadata entry with a bad digest
  const osi = os as ObjectStoreImpl;
  const soi = await osi.rawInfo("corrupt");
  assertExists(soi);
  soi!.digest = `${digestType}${"A".repeat(43)}=`;
  const js = jetstream(nc);
  await js.publish(
    `$O.test.M.${Base64UrlPaddedCodec.encode("corrupt")}`,
    JSON.stringify(soi),
  );

  await assertRejects(
    async () => {
      await os.getBlob("corrupt");
    },
    Error,
    "digests do not match",
  );

  await cleanup(ns, nc);
});

Deno.test("objectstore - watcherPrefix", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  const js = jetstream(nc, { watcherPrefix: "hello" });
  const objm = new Objm(js);
  const os = await objm.create("test");

  const watches = await os.watch() as QueuedIteratorImpl<ObjectWatchInfo>;
  const oc = watches._data as PushConsumer;
  const { config: { deliver_subject } } = await oc.info(true);

  assertEquals(deliver_subject?.split(".")[0], "hello");

  await cleanup(ns, nc);
});

Deno.test("objectstore - fast ingest enabled by default", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }

  const objm = new Objm(nc);
  const os = await objm.create("FI") as ObjectStoreImpl;
  assertEquals(os.supportsFastIngest, true);

  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.info("OBJ_FI");
  assertEquals(si.config.allow_batched, true);

  await cleanup(ns, nc);
});

Deno.test("objectstore - disableFastIngest opts out", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }

  const objm = new Objm(nc);
  const os = await objm.create("NOFI", {
    disableFastIngest: true,
  }) as ObjectStoreImpl;
  assertEquals(os.supportsFastIngest, false);

  const jsm = await jetstreamManager(nc);
  const si = await jsm.streams.info("OBJ_NOFI");
  assertEquals(si.config.allow_batched ?? false, false);

  await cleanup(ns, nc);
});

Deno.test("objectstore - disableFastIngest honored on existing FI bucket", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }

  const objm = new Objm(nc);
  // first create the bucket WITH fast ingest
  const fiBucket = await objm.create("EXISTFI") as ObjectStoreImpl;
  assertEquals(fiBucket.supportsFastIngest, true);

  // re-open via create() with disableFastIngest — stream config still has
  // allow_batched=true, but the caller opted out so this instance must
  // not use fast ingest
  const optOutBucket = await objm.create("EXISTFI", {
    disableFastIngest: true,
  }) as ObjectStoreImpl;
  assertEquals(optOutBucket.supportsFastIngest, false);

  await cleanup(ns, nc);
});

Deno.test("objectstore - open(check=false) disables fast ingest", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }

  const objm = new Objm(nc);
  // bucket exists with allow_batched=true on the underlying stream
  const created = await objm.create("PROBE") as ObjectStoreImpl;
  assertEquals(created.supportsFastIngest, true);

  // open with check=true picks up the stream's allow_batched flag
  const probed = await objm.open("PROBE", true) as ObjectStoreImpl;
  assertEquals(probed.supportsFastIngest, true);

  // open with check=false skips the probe, so capability is unknown — fall
  // back to the safe default (legacy publish path always works)
  const noProbe = await objm.open("PROBE", false) as ObjectStoreImpl;
  assertEquals(noProbe.supportsFastIngest, false);

  await cleanup(ns, nc);
});

Deno.test("objectstore - fast ingest multi-chunk roundtrip", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }

  // size that forces multiple chunks at the default 128 KiB chunk size
  const blob = makeData(512 * 1024 + 31);

  const objm = new Objm(nc);
  const os = await objm.create("FIBLOB") as ObjectStoreImpl;
  assertEquals(os.supportsFastIngest, true);

  const oi = await os.put(
    { name: "BLOB" },
    readableStreamFrom(blob),
  );
  assert(oi.chunks > 1);
  assertEquals(oi.size, blob.length);
  assertEquals(oi.digest, digest(blob));

  const or = await os.get("BLOB");
  assertExists(or);
  const read = await fromReadableStream(or!.data);
  assert(equals(read, blob));

  await cleanup(ns, nc);
});

Deno.test("objectstore - cross-read: writes with FI readable without FI", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }

  const blob = makeData(300 * 1024);
  const blobDigest = digest(blob);

  // write with FI enabled (default)
  const objm = new Objm(nc);
  const fiBucket = await objm.create("XR_FI") as ObjectStoreImpl;
  assertEquals(fiBucket.supportsFastIngest, true);
  const fiOi = await fiBucket.put({ name: "data" }, readableStreamFrom(blob));

  // write with FI disabled — same payload
  const noFiBucket = await objm.create("XR_NOFI", {
    disableFastIngest: true,
  }) as ObjectStoreImpl;
  assertEquals(noFiBucket.supportsFastIngest, false);
  const noFiOi = await noFiBucket.put(
    { name: "data" },
    readableStreamFrom(blob),
  );

  // both writes must produce the same digest as the source data
  assertEquals(fiOi.digest, blobDigest);
  assertEquals(noFiOi.digest, blobDigest);

  // round-trip both buckets — bytes must match the source byte-for-byte
  for (const bucket of [fiBucket, noFiBucket]) {
    const or = await bucket.get("data");
    assertExists(or);
    const read = await fromReadableStream(or!.data);
    assert(equals(read, blob));
  }

  await cleanup(ns, nc);
});

Deno.test("objectstore - cross-read: native-sha write readable, js-sha read verifies digest", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }

  const blob = makeData(200 * 1024);

  const objm = new Objm(nc);

  try {
    // write under native sha
    setSha256Backend("native");
    const os = await objm.create("XS") as ObjectStoreImpl;
    const oi = await os.put({ name: "data" }, readableStreamFrom(blob));
    assertEquals(oi.digest, digest(blob));

    // read under js sha — digest verification on get() must still pass
    setSha256Backend("js");
    const or = await os.get("data");
    assertExists(or);
    const read = await fromReadableStream(or!.data);
    assert(equals(read, blob));

    // and the reverse: write js, read native
    setSha256Backend("js");
    const os2 = await objm.create("XS2") as ObjectStoreImpl;
    const oi2 = await os2.put({ name: "data" }, readableStreamFrom(blob));
    assertEquals(oi2.digest, digest(blob));

    setSha256Backend("native");
    const or2 = await os2.get("data");
    assertExists(or2);
    const read2 = await fromReadableStream(or2!.data);
    assert(equals(read2, blob));
  } finally {
    setSha256Backend("js");
  }

  await cleanup(ns, nc);
});

Deno.test("objectstore - existing bucket without allow_batched uses legacy path", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  if (await notCompatible(ns, nc, "2.14.0")) {
    return;
  }

  // pre-create the OBJ stream by hand without allow_batched
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "OBJ_LEGACY",
    subjects: ["$O.LEGACY.C.>", "$O.LEGACY.M.>"],
    allow_direct: true,
    allow_rollup_hdrs: true,
    discard: DiscardPolicy.New,
  });

  const objm = new Objm(nc);
  const os = await objm.open("LEGACY") as ObjectStoreImpl;
  assertEquals(os.supportsFastIngest, false);

  const blob = makeData(300 * 1024);
  const oi = await os.put({ name: "X" }, readableStreamFrom(blob));
  assertEquals(oi.digest, digest(blob));

  const or = await os.get("X");
  assertExists(or);
  const read = await fromReadableStream(or!.data);
  assert(equals(read, blob));

  await cleanup(ns, nc);
});
