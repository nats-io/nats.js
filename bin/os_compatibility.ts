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

import { connect, millis, Msg } from "../src/mod.ts";
import { sha256 } from "@chiefbiiko/sha256";

const servers = Deno.env.get("NATS_URL") || "nats://localhost:4222";
const nc = await connect({ servers });
const js = nc.jetstream();
console.log("connected");

const sub = nc.subscribe("tests.object-store.>");

const defaultBucket = async function (m: Msg): Promise<void> {
  const config = m.json<{
    config: {
      bucket: string;
    };
  }>();
  await js.views.os(config.config.bucket);
  m.respond();
};

const customBucket = async function (m: Msg): Promise<void> {
  const testRequest = m.json<{ config: Record<string, unknown> }>();
  console.log(`custom  config: ${JSON.stringify(testRequest)}`);
  const name = testRequest.config.bucket as string || "";
  delete testRequest.config.bucket;
  testRequest.config.millis = millis(testRequest.config.max_age as number || 0);
  await js.views.os(name, testRequest.config);
  m.respond();
};

const putObject = async function (m: Msg): Promise<void> {
  const testRequest = m.json<{
    bucket: string;
    url: string;
    config: {
      description: string;
      name: string;
    };
  }>();
  console.log(`put object config: ${JSON.stringify(testRequest)}`);

  const file = await fetch(testRequest.url);

  if (!file.body) {
    throw new Error("Failed to fetch body");
  }
  const bucket = await js.views.os(testRequest.bucket);

  await bucket.put(testRequest.config, file.body);
  m.respond();
};

const getObject = async function (m: Msg): Promise<void> {
  const testRequest = m.json<
    {
      bucket: string;
      object: string;
    }
  >();
  console.log(`get object config: ${JSON.stringify(testRequest)}`);

  const bucket = await js.views.os(testRequest.bucket);
  const object = await bucket.getBlob(testRequest.object);

  if (!object) {
    throw new Error("Failed to get object");
  }

  const hash = sha256(object);
  m.respond(hash);
};

const updateMetadata = async function (m: Msg): Promise<void> {
  const testRequest = m.json<
    {
      bucket: string;
      object: string;
      config: {
        description: string;
        name: string;
      };
    }
  >();
  const bucket = await js.views.os(testRequest.bucket);
  await bucket.update(testRequest.object, testRequest.config);
  m.respond();
};

const watchUpdates = async function (m: Msg): Promise<void> {
  const testRequest = m.json<{
    bucket: string;
  }>();

  const bucket = await js.views.os(testRequest.bucket);
  const iter = await bucket.watch({ includeHistory: false });

  for await (const object of iter) {
    m.respond(object?.digest);
    break;
  }
};

const watch = async function (m: Msg): Promise<void> {
  const testRequest = m.json<{
    bucket: string;
  }>();

  const bucket = await js.views.os(testRequest.bucket);
  const iter = await bucket.watch({ includeHistory: true });

  const values: string[] = [];
  for await (const object of iter) {
    if (object) {
      values.push(object.digest);
    }
    if (values.length == 2) {
      break; // Exit the loop once two values have been collected
    }
  }
  const result = values.join(",");
  m.respond(result);
};

const getLink = async function (m: Msg): Promise<void> {
  const testRequest = m.json<{
    object: string;
    bucket: string;
  }>();

  const bucket = await js.views.os(testRequest.bucket);
  const object = await bucket.getBlob(testRequest.object);

  if (object) {
    const hash = sha256(object);
    m.respond(hash);
  }
};

const putLink = async function (m: Msg): Promise<void> {
  const testRequest = m.json<{
    object: string;
    bucket: string;
    link_name: string;
  }>();

  const bucket = await js.views.os(testRequest.bucket);
  const object = await bucket.get(testRequest.object);

  if (object) {
    await bucket.link(testRequest.link_name, object.info);
  }
  m.respond();
};

const result = function (test: string) {
  return function (message: Msg): Promise<void> {
    if (message.headers) {
      console.log(`test ${test} failed`);
      return Promise.reject("test failed");
    } else {
      console.log(`test ${test} ok`);
      return Promise.resolve();
    }
  };
};

const opts = [
  defaultBucket,
  result("defaultBucket"),
  customBucket,
  result("customBucket"),
  putObject,
  result("putObject"),
  getObject,
  result("getObject"),
  updateMetadata,
  result("updateMetadata"),
  watchUpdates,
  result("watchUpdates"),
  watch,
  result("watch"),
  getLink,
  result("getLink"),
  putLink,
  result("putLink"),
];

console.log("waiting for tests");
let i = 0;
for await (const m of sub) {
  await opts[i++](m);
}
console.log("all tests done");
