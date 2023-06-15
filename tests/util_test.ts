/*
 * Copyright 2023 The NATS Authors
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
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { SimpleMutex } from "../nats-base-client/util.ts";

Deno.test("util - simple mutex", () => {
  const r = new SimpleMutex(1);
  assertEquals(r.max, 1);
  assertEquals(r.current, 0);

  r.lock().catch();
  assertEquals(r.current, 1);

  r.lock().catch();
  assertEquals(r.current, 2);
  assertEquals(r.waiting.length, 1);

  r.unlock();
  assertEquals(r.current, 1);
  assertEquals(r.waiting.length, 0);
});