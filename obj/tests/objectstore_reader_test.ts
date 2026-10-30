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

import { cleanup, jetstreamServerConf, setup } from "nst";
import { assertEquals, assertRejects } from "@std/assert";
import { type ObjectStoreImpl, Objm } from "../src/objectstore.ts";
import type { ObjectStoreOptions } from "../src/types.ts";

for (const allowBatched of [false, true]) {
  for (const size of [0, 1024]) {
    Deno.test(`os - put releases the reader after ${size} bytes (batched=${allowBatched})`, async () => {
      const { ns, nc } = await setup(jetstreamServerConf({}));
      try {
        const os = await new Objm(nc).create(
          "reader",
          { allowBatched } as Partial<ObjectStoreOptions>,
        );
        const data = new Uint8Array(size).fill(17);
        const rs = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        });
        const info = await os.put(
          { name: "data", options: { max_chunk_size: 256 } },
          rs,
        );
        assertEquals(info.size, size);
        assertEquals(await os.getBlob("data"), data);
        assertEquals(rs.locked, false);
      } finally {
        await cleanup(ns, nc);
      }
    });
  }

  Deno.test(`os - failed put lets the caller cancel the source (batched=${allowBatched})`, async () => {
    const { ns, nc } = await setup(jetstreamServerConf({}));
    try {
      const os = await new Objm(nc).create(
        "reader",
        { max_bytes: 512, allowBatched } as Partial<ObjectStoreOptions>,
      );
      let canceled = false;
      let cancelReason: unknown;
      const rs = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(256));
        },
        cancel(reason) {
          canceled = true;
          cancelReason = reason;
        },
      });
      const err = await assertRejects(() =>
        os.put({ name: "data", options: { max_chunk_size: 256 } }, rs)
      );
      assertEquals(canceled, false);
      // the upload has stopped reading. the caller must be able to close a file
      // or cancel a response body that supplies the rest of the object.
      await rs.cancel(err);
      assertEquals(canceled, true);
      assertEquals(cancelReason, err);
      assertEquals(rs.locked, false);
      assertEquals((await os.status()).streamInfo.state.messages, 0);
    } finally {
      await cleanup(ns, nc);
    }
  });
}

Deno.test("os - put releases an errored reader", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  try {
    const os = await new Objm(nc).create("reader");
    const expected = new Error("source failed");
    const rs = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(expected);
      },
    });
    const err = await assertRejects(() => os.put({ name: "data" }, rs));
    assertEquals(err, expected);
    assertEquals(rs.locked, false);
  } finally {
    await cleanup(ns, nc);
  }
});

Deno.test("os - put releases the reader when cleanup fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  try {
    const os = await new Objm(nc).create("reader") as ObjectStoreImpl;
    os.jsm.streams.purge = () => Promise.reject(new Error("cleanup failed"));
    const expected = new Error("source failed");
    const rs = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(expected);
      },
    });
    const err = await assertRejects(() => os.put({ name: "data" }, rs));
    assertEquals(err, expected);
    assertEquals(rs.locked, false);
  } finally {
    await cleanup(ns, nc);
  }
});

Deno.test("os - put preserves a reader owned by the caller", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}));
  try {
    const os = await new Objm(nc).create("reader");
    const data = new Uint8Array([1, 2, 3]);
    const rs = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    const reader = rs.getReader();
    try {
      await assertRejects(() => os.put({ name: "data" }, rs), TypeError);
      assertEquals(rs.locked, true);
      assertEquals((await reader.read()).value, data);
    } finally {
      reader.releaseLock();
    }
  } finally {
    await cleanup(ns, nc);
  }
});
