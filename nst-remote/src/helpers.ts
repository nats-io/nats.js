/*
 * Copyright 2020-2026 The NATS Authors
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

import type { ConnectionOptions, NatsConnection } from "@nats-io/nats-core";
import { compare, parseSemVer } from "@nats-io/nats-core/internal";
import type { ManagedServer } from "@nats-io/nst";
import { NatsServer } from "./server.ts";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export type SetupContext = {
  ns: NatsServer;
  nc: NatsConnection;
  [Symbol.asyncDispose](): Promise<void>;
};

export function jsopts(): Record<string, unknown> {
  return {
    jetstream: {
      max_file_store: 1024 * 1024,
      max_mem_store: 1024 * 1024,
    },
  };
}

export function wsopts(): Record<string, unknown> {
  return {
    websocket: { no_tls: true },
  };
}

export function jetstreamServerConf(
  opts: unknown = {},
): Record<string, unknown> {
  return Object.assign(jsopts(), opts);
}

export function jetstreamExportServerConf(
  opts: unknown = {},
  prefix = "IPA.>",
): Record<string, unknown> {
  const template = {
    no_auth_user: "a",
    accounts: {
      JS: {
        jetstream: "enabled",
        users: [{ user: "js", password: "js" }],
        exports: [
          { service: "$JS.API.>", response_type: "stream" },
          { service: "$JS.ACK.>", response_type: "stream" },
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

export function wsServerConf(opts: unknown = {}): Record<string, unknown> {
  return Object.assign(wsopts(), opts);
}

export async function setup(
  serverConf?: Record<string, unknown>,
  clientOpts?: Partial<ConnectionOptions>,
): Promise<SetupContext> {
  const ns = await NatsServer.start(serverConf);
  const nc = await ns.connect(clientOpts);
  return {
    ns,
    nc,
    [Symbol.asyncDispose]() {
      return cleanup(ns, nc);
    },
  };
}

export async function cleanup(
  ns: ManagedServer,
  ...nc: NatsConnection[]
): Promise<void> {
  await Promise.all(nc.map((v) => v.close()));
  await ns.stop(true);
}

export async function notCompatible(
  ns: ManagedServer,
  nc: NatsConnection,
  version?: string,
): Promise<boolean> {
  version = version ?? "2.3.3";
  const varz = await ns.varz() as unknown as Record<string, string>;
  const sv = parseSemVer(varz.version);
  if (compare(sv, parseSemVer(version)) < 0) {
    log(
      `skipping test as server (${varz.version}) doesn't implement required feature from ${version} `,
    );
    await cleanup(ns, nc);
    return true;
  }
  return false;
}

export async function notSupported(
  ns: ManagedServer,
  version?: string,
): Promise<boolean> {
  version = version ?? "2.3.3";
  const varz = await ns.varz() as unknown as Record<string, string>;
  const sv = parseSemVer(varz.version);
  if (compare(sv, parseSemVer(version)) < 0) {
    log(
      `skipping test as server (${varz.version}) doesn't implement required feature from ${version} `,
    );
    return true;
  }
  return false;
}

function log(msg: string): void {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const out = g.process?.stdout?.write?.bind(g.process.stdout) ??
    ((s: string) => console.log(s));
  out(`${YELLOW}${msg}${RESET}`);
}
