/*
 * Copyright 2021-2023 The NATS Authors
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

import { compare, Feature, Features, parseSemVer } from "../src/semver.ts";
import {
  assert,
  assertEquals,
  assertFalse,
  assertThrows,
} from "jsr:@std/assert";

Deno.test("semver", () => {
  const pt: { a: string; b: string; r: number }[] = [
    { a: "1.0.0", b: "1.0.0", r: 0 },
    { a: "1.0.1", b: "1.0.0", r: 1 },
    { a: "1.1.0", b: "1.0.1", r: 1 },
    { a: "1.1.1", b: "1.1.0", r: 1 },
    { a: "1.1.1", b: "1.1.1", r: 0 },
    { a: "1.1.100", b: "1.1.099", r: 1 },
    { a: "2.0.0", b: "1.500.500", r: 1 },
  ];

  pt.forEach((t) => {
    assertEquals(
      compare(parseSemVer(t.a), parseSemVer(t.b)),
      t.r,
      `compare(${t.a}, ${t.b})`,
    );
  });
});

Deno.test("semver - feature basics", () => {
  // sanity version check
  const f = new Features(parseSemVer("4.0.0"));
  assert(f.require("4.0.0"));
  assertFalse(f.require("5.0.0"));

  // change the version to 2.8.3
  f.update(parseSemVer("2.8.3"));
  let info = f.get(Feature.JS_PULL_MAX_BYTES);
  assertEquals(info.ok, true);
  assertEquals(info.min, "2.8.3");
  assert(f.supports(Feature.JS_PULL_MAX_BYTES));
  assertFalse(f.isDisabled(Feature.JS_PULL_MAX_BYTES));
  // disable the feature
  f.disable(Feature.JS_PULL_MAX_BYTES);
  assert(f.isDisabled(Feature.JS_PULL_MAX_BYTES));
  assertFalse(f.supports(Feature.JS_PULL_MAX_BYTES));
  info = f.get(Feature.JS_PULL_MAX_BYTES);
  assertEquals(info.ok, false);
  assertEquals(info.min, "unknown");

  // remove all disablements
  f.resetDisabled();
  assert(f.supports(Feature.JS_PULL_MAX_BYTES));

  f.update(parseSemVer("2.8.2"));
  assertFalse(f.supports(Feature.JS_PULL_MAX_BYTES));
});

Deno.test("semver - parse", () => {
  assertThrows(() => parseSemVer(), Error, "'' is not a semver value");
  assertThrows(() => parseSemVer(" "), Error, "' ' is not a semver value");
  assertThrows(
    () => parseSemVer("a.1.2"),
    Error,
    "'a.1.2' is not a semver value",
  );
  assertThrows(
    () => parseSemVer("1.a.2"),
    Error,
    "'1.a.2' is not a semver value",
  );
  assertThrows(
    () => parseSemVer("1.2.a"),
    Error,
    "'1.2.a' is not a semver value",
  );

  let sv = parseSemVer("v1.2.3");
  assertEquals(sv.major, 1);
  assertEquals(sv.minor, 2);
  assertEquals(sv.micro, 3);

  sv = parseSemVer("1.2.3-this-is-a-tag");
  assertEquals(sv.major, 1);
  assertEquals(sv.minor, 2);
  assertEquals(sv.micro, 3);
});
