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

import { toConf } from "./launcher.ts";
import { assertEquals } from "@std/assert";

Deno.test("conf - serializing simple", () => {
  const x = {
    test: "one",
  };
  const y = toConf(x);

  const buf = y.split("\n");
  buf.forEach(function (e, i) {
    buf[i] = e.trim();
  });

  const z = buf.join(" ");
  assertEquals(z, "test: one");
});

Deno.test("conf - serializing nested", () => {
  const x = {
    a: "one",
    b: {
      a: "two",
    },
  };
  const y = toConf(x);

  const buf = y.split("\n");
  buf.forEach(function (e, i) {
    buf[i] = e.trim();
  });

  const z = buf.join(" ");
  assertEquals(z, "a: one b { a: two }");
});

Deno.test("conf - serializing array", () => {
  const x = {
    a: "one",
    b: ["a", "b", "c"],
  };
  const y = toConf(x);

  const buf = y.split("\n");
  buf.forEach(function (e, i) {
    buf[i] = e.trim();
  });

  const z = buf.join(" ");
  assertEquals(z, "a: one b [ a b c ]");
});

Deno.test("conf - serializing array objs", () => {
  const x = {
    a: "one",
    b: [{
      a: "a",
    }, {
      b: "b",
    }, {
      c: "c",
    }],
  };
  const y = toConf(x);
  const buf = y.split("\n");
  buf.forEach(function (e, i) {
    buf[i] = e.trim();
  });

  const z = buf.join(" ");
  assertEquals(z, "a: one b [ { a: a } { b: b } { c: c } ]");
});

Deno.test("conf - serializing array arrays", () => {
  const x = {
    a: "one",
    b: [{
      a: "a",
      b: ["b", "c"],
    }, {
      b: "b",
    }, {
      c: "c",
    }],
  };
  const y = toConf(x);
  const buf = y.split("\n");
  buf.forEach(function (e, i) {
    buf[i] = e.trim();
  });

  const z = buf.join(" ");
  assertEquals(z, "a: one b [ { a: a b [ b c ] } { b: b } { c: c } ]");
});

Deno.test("conf - strings that start with numbers are quoted", () => {
  const x = {
    a: "2hello",
    b: 2,
    c: "hello",
  };
  const y = toConf(x);
  const buf = y.split("\n");
  buf.forEach(function (e, i) {
    buf[i] = e.trim();
  });

  const z = buf.join(" ");
  assertEquals(z, 'a: "2hello" b: 2 c: hello');
});
