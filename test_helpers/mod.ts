/*
 * Copyright 2020-2023 The NATS Authors
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

import type {
  ConnectionOptions,
  NatsConnection,
} from "../core/src/internal_mod.ts";
import { compare, extend, parseSemVer } from "../core/src/internal_mod.ts";

import { NatsServer } from "./launcher.ts";
import { red, yellow } from "jsr:@std/fmt/colors";
import { connect } from "./connect.ts";
export { connect } from "./connect.ts";
import { ConnectFn } from "../core/src/core.ts";
export { check } from "./check.ts";
export { Lock } from "./lock.ts";
export { Connection, TestServer } from "./test_server.ts";
export {
  assertBetween,
  assertErrorCode,
  assertThrowsAsyncErrorCode,
  assertThrowsErrorCode,
} from "./asserts.ts";
export { NatsServer, ServerSignals } from "./launcher.ts";

export function disabled(reason: string): void {
  const m = new TextEncoder().encode(red(`skipping: ${reason} `));
  Deno.stdout.writeSync(m);
}

export function jsopts() {
  const store_dir = Deno.makeTempDirSync({ prefix: "jetstream" });
  return {
    // debug: true,
    // trace: true,
    jetstream: {
      max_file_store: 1024 * 1024,
      max_mem_store: 1024 * 1024,
      store_dir,
    },
  };
}

export function jetstreamExportServerConf(
  opts: unknown = {},
  prefix = "IPA.>",
): Record<string, unknown> {
  const template = {
    "no_auth_user": "a",
    accounts: {
      JS: {
        jetstream: "enabled",
        users: [{ user: "js", password: "js" }],
        exports: [
          { service: "$JS.API.>" },
          { service: "$JS.ACK.>" },
          { stream: "A.>", accounts: ["A"] },
        ],
      },
      A: {
        users: [{ user: "a", password: "s3cret" }],
        imports: [
          { service: { subject: "$JS.API.>", account: "JS" }, to: prefix },
          { service: { subject: "$JS.ACK.>", account: "JS" } },
          { stream: { subject: "A.>", account: "JS" } },
        ],
      },
    },
  };
  const conf = Object.assign(template, opts);
  return jetstreamServerConf(conf);
}

export function jetstreamServerConf(
  opts: unknown = {},
): Record<string, unknown> {
  const conf = Object.assign(jsopts(), opts);
  if (typeof conf.jetstream.store_dir !== "string") {
    conf.jetstream.store_dir = Deno.makeTempDirSync({ prefix: "jetstream" });
  }
  return conf as Record<string, unknown>;
}

export async function _setup(
  fn: ConnectFn,
  serverConf?: Record<string, unknown>,
  clientOpts?: Partial<ConnectionOptions>,
): Promise<{ ns: NatsServer; nc: NatsConnection }> {
  const dt = serverConf as { debug: boolean; trace: boolean };
  const debug = dt && (dt.debug || dt.trace);
  const ns = await NatsServer.start(serverConf, debug);
  clientOpts = clientOpts ? clientOpts : {};
  const copts = extend({ port: ns.port }, clientOpts) as ConnectionOptions;
  const nc = await fn(copts);
  return { ns, nc };
}

export function setup(
  serverConf?: Record<string, unknown>,
  clientOpts?: Partial<ConnectionOptions>,
): Promise<{ ns: NatsServer; nc: NatsConnection }> {
  return _setup(connect, serverConf, clientOpts);
}

export async function cleanup(
  ns: NatsServer,
  ...nc: NatsConnection[]
): Promise<void> {
  const conns: Promise<void>[] = [];
  nc.forEach((v) => {
    conns.push(v.close());
  });
  await Promise.all(conns);
  await ns.stop(true);
}

export async function notCompatible(
  ns: NatsServer,
  nc: NatsConnection,
  version?: string,
): Promise<boolean> {
  version = version ?? "2.3.3";
  const varz = await ns.varz() as unknown as Record<string, string>;
  const sv = parseSemVer(varz.version);
  if (compare(sv, parseSemVer(version)) < 0) {
    const m = new TextEncoder().encode(yellow(
      `skipping test as server (${varz.version}) doesn't implement required feature from ${version} `,
    ));
    await Deno.stdout.write(m);
    await cleanup(ns, nc);
    return true;
  }
  return false;
}

export function flakyTest(
    fn:  () => void | Promise<void>,
    { count = 3 } = {},
): () => Promise<void> {
  return async () => {
    const errors: Error[] = [];
    for (let i = 0; i < count; i++) {
      try {
        return await fn();
      } catch (error) {
        errors.push(error);
      }
    }
    throw new AggregateError(errors);
  }
}
