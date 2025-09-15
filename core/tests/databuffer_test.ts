/*
 * Copyright 2018-2023 The NATS Authors
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
import { assertEquals } from "@std/assert";
import { DataBuffer } from "../src/internal_mod.ts";

Deno.test("databuffer - empty", () => {
  const buf = new DataBuffer();
  assertEquals(0, buf.length());
  assertEquals(0, buf.size());
  assertEquals(0, buf.drain(1000).byteLength);
  assertEquals(0, buf.peek().byteLength);
});

Deno.test("databuffer - simple", () => {
  const buf = new DataBuffer();
  buf.fill(DataBuffer.fromAscii("Hello"));
  buf.fill(DataBuffer.fromAscii(" "));
  buf.fill(DataBuffer.fromAscii("World"));
  assertEquals(3, buf.length());
  assertEquals(11, buf.size());
  const p = buf.peek();
  assertEquals(11, p.byteLength);
  assertEquals("Hello World", DataBuffer.toAscii(p));
  const d = buf.drain();
  assertEquals(11, d.byteLength);
  assertEquals("Hello World", DataBuffer.toAscii(d));
});

Deno.test("databuffer - from empty", () => {
  //@ts-ignore: bad argument to fn
  const a = DataBuffer.fromAscii(undefined);
  assertEquals(0, a.byteLength);
});

Deno.test("databuffer - multi-fill", () => {
  const buf = new DataBuffer();
  const te = new TextEncoder();
  buf.fill(te.encode("zero"));
  assertEquals(buf.length(), 1);
  assertEquals(buf.byteLength, 4);

  buf.fill(te.encode("one"), te.encode("two"));
  assertEquals(buf.length(), 3);
  assertEquals(buf.byteLength, 10);
});
