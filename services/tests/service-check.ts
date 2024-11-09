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

import { cli } from "https://deno.land/x/cobra@v0.0.9/mod.ts";
import { connect } from "jsr:@nats-io/nats-transport-deno@3.0.0-4";
import { collect, parseSemVer } from "@nats-io/nats-core/internal";

import type { NatsConnection } from "@nats-io/nats-core/internal";

import type { ServiceIdentity, ServiceInfo, ServiceStats } from "../src/mod.ts";
import {
  ServiceError,
  ServiceResponseType,
  ServiceVerb,
  Svc,
} from "../src/mod.ts";

import type { ServiceClientImpl } from "../src/serviceclient.ts";
import type { JSONSchemaType, ValidateFunction } from "npm:ajv";
import { Ajv } from "npm:ajv";

const ajv = new Ajv();

const root = cli({
  use: "service-check [--name name] [--server host:port]",
  run: async (cmd, _args, flags): Promise<number> => {
    const servers = [flags.value<string>("server")];
    const name = flags.value<string>("name");

    let error;
    let nc: NatsConnection | null = null;
    try {
      nc = await connect({ servers });
      await invoke(nc!, name);
      await checkPing(nc!, name);
      await checkInfo(nc!, name);
      await checkStats(nc!, name);
    } catch (err) {
      cmd.stderr(err.message);
      console.log(err);
      error = err;
    } finally {
      await nc?.close();
    }
    return error ? Promise.resolve(1) : Promise.resolve(0);
  },
});
root.addFlag({
  short: "n",
  name: "name",
  type: "string",
  usage: "service name to filter on",
  default: "",
  persistent: true,
  required: true,
});

root.addFlag({
  name: "server",
  type: "string",
  usage: "NATS server to connect to",
  default: "localhost:4222",
  persistent: true,
});

function filter<T extends ServiceIdentity>(name: string, responses: T[]): T[] {
  return responses.filter((r) => {
    return r.name === name;
  });
}
function filterExpectingOnly<T extends ServiceIdentity>(
  tag: string,
  name: string,
  responses: T[],
): T[] {
  const filtered = filter(name, responses);
  assertEquals(
    filtered.length,
    responses.length,
    `expected ${tag} to have only services named ${name}`,
  );
  return filtered;
}

function checkResponse<T extends ServiceIdentity>(
  tag: string,
  responses: T[],
  validator: ValidateFunction<T>,
) {
  assert(responses.length > 0, `expected responses for ${tag}`);

  responses.forEach((r) => {
    const valid = validator(r);
    if (!valid) {
      console.log(r);
      console.log(validator.errors);
      throw new Error(tag + " " + validator.errors?.[0].message);
    }
  });
}
//
async function checkStats(nc: NatsConnection, name: string) {
  const validateFn = ajv.compile(statsSchema);
  await check<ServiceStats>(nc, ServiceVerb.STATS, name, validateFn, (v) => {
    assertEquals(v.type, ServiceResponseType.STATS);
    parseSemVer(v.version);
  });
}

async function checkInfo(nc: NatsConnection, name: string) {
  const validateFn = ajv.compile(infoSchema);
  await check<ServiceInfo>(nc, ServiceVerb.INFO, name, validateFn, (v) => {
    assertEquals(v.type, ServiceResponseType.INFO);
    parseSemVer(v.version);
  });
}

async function checkPing(nc: NatsConnection, name: string) {
  const validateFn = ajv.compile(pingSchema);
  await check<ServiceIdentity>(nc, ServiceVerb.PING, name, validateFn, (v) => {
    assertEquals(v.type, ServiceResponseType.PING);
    parseSemVer(v.version);
  });
}

async function invoke(nc: NatsConnection, name: string): Promise<void> {
  const svc = new Svc(nc);
  const sc = svc.client();
  const infos = await collect(await sc.info(name));

  let proms = infos.map((v) => {
    return nc.request(v.endpoints[0].subject);
  });
  let responses = await Promise.all(proms);
  responses.forEach((m) => {
    assertEquals(
      ServiceError.isServiceError(m),
      true,
      "expected service without payload to return error",
    );
  });

  // the service should throw/register an error if "error" is specified as payload
  proms = infos.map((v) => {
    return nc.request(v.endpoints[0].subject, "error");
  });
  responses = await Promise.all(proms);
  responses.forEach((m) => {
    assertEquals(
      ServiceError.isServiceError(m),
      true,
      "expected service without payload to return error",
    );
  });

  proms = infos.map((v, idx) => {
    return nc.request(
      v.endpoints[0].subject,
      `hello ${idx}`,
    );
  });
  responses = await Promise.all(proms);
  responses.forEach((m, idx) => {
    const r = `hello ${idx}`;
    assertEquals(
      m.string(),
      r,
      `expected service response ${r}`,
    );
  });
}

async function check<T extends ServiceIdentity>(
  nc: NatsConnection,
  verb: ServiceVerb,
  name: string,
  validateFn: ValidateFunction<T>,
  check?: (v: T) => void,
) {
  const fn = (d: T[]): void => {
    if (check) {
      try {
        d.forEach(check);
      } catch (err) {
        throw new Error(`${verb} check: ${err.message}`);
      }
    }
  };

  const svc = new Svc(nc);
  const sc = svc.client() as ServiceClientImpl;
  // all
  let responses = filter(
    name,
    await collect(await sc.q<T>(verb)),
  );

  assert(responses.length >= 1, `expected at least 1 response to ${verb}`);
  fn(responses);
  checkResponse(`${verb}()`, responses, validateFn);

  // just matching name
  responses = filterExpectingOnly(
    `${verb}(${name})`,
    name,
    await collect(await sc.q<ServiceIdentity>(verb, name)),
  );
  assert(
    responses.length >= 1,
    `expected at least 1 response to ${verb}.${name}`,
  );
  fn(responses);
  checkResponse(`${verb}(${name})`, responses, validateFn);

  // specific service
  responses = filterExpectingOnly(
    `${verb}(${name})`,
    name,
    await collect(await sc.q<ServiceIdentity>(verb, name, responses[0].id)),
  );
  assert(
    responses.length === 1,
    `expected at least 1 response to ${verb}.${name}.${responses[0].id}`,
  );
  fn(responses);
  checkResponse(`${verb}(${name})`, responses, validateFn);
}

function assert(v: unknown, msg?: string) {
  if (typeof v === undefined || typeof v === null || v === false) {
    throw new Error(msg || "expected value to be truthy");
  }
}

function assertEquals(v: unknown, expected: unknown, msg?: string) {
  if (v !== expected) {
    throw new Error(msg || `expected ${v} === ${expected}`);
  }
}

const statsSchema: JSONSchemaType<ServiceStats> = {
  type: "object",
  properties: {
    type: { type: "string" },
    name: { type: "string" },
    id: { type: "string" },
    version: { type: "string" },
    started: { type: "string" },
    metadata: {
      type: "object",
      minProperties: 1,
    },
    endpoints: {
      type: "array",
      items: {
        type: "object",
        properties: {
          num_requests: { type: "number" },
          num_errors: { type: "number" },
          last_error: { type: "string" },
          processing_time: { type: "number" },
          average_processing_time: { type: "number" },
          data: { type: "string" },
          queue_group: { type: "string" },
        },
        required: [
          "num_requests",
          "num_errors",
          "last_error",
          "processing_time",
          "average_processing_time",
          "data",
          "queue_group",
        ],
      },
    },
  },
  required: [
    "type",
    "name",
    "id",
    "version",
    "started",
    "metadata",
  ],
  additionalProperties: false,
};

const infoSchema: JSONSchemaType<ServiceInfo> = {
  type: "object",
  properties: {
    type: { type: "string" },
    name: { type: "string" },
    id: { type: "string" },
    version: { type: "string" },
    description: { type: "string" },
    endpoints: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          subject: { type: "string" },
          metadata: { type: "object", minProperties: 1 },
        },
      },
    },
    metadata: {
      type: "object",
      minProperties: 1,
    },
  },
  required: ["type", "name", "id", "version", "metadata", "endpoints"],
  additionalProperties: false,
};

const pingSchema: JSONSchemaType<ServiceIdentity> = {
  type: "object",
  properties: {
    type: { type: "string" },
    name: { type: "string" },
    id: { type: "string" },
    version: { type: "string" },
    metadata: {
      type: "object",
      minProperties: 1,
    },
  },
  required: ["type", "name", "id", "version", "metadata"],
  additionalProperties: false,
};

Deno.exit(await root.execute(Deno.args));
