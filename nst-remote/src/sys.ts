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

import type { NatsConnection } from "@nats-io/nats-core";
import { getConnect } from "@nats-io/nst";
import { getRegisteredConnect } from "./client.ts";

async function resolveConnect(): Promise<
  // deno-lint-ignore no-explicit-any
  (opts: any) => Promise<NatsConnection>
> {
  const registered = getRegisteredConnect();
  if (registered) return registered;
  try {
    // deno-lint-ignore no-explicit-any
    return getConnect() as (opts: any) => Promise<NatsConnection>;
  } catch {
    // fallthrough
  }
  // deno-lint-ignore no-explicit-any
  if ((globalThis as any).Deno) {
    const { connect } = await import("@nats-io/transport-deno");
    // deno-lint-ignore no-explicit-any
    return connect as unknown as (opts: any) => Promise<NatsConnection>;
  }
  throw new Error(
    "nst-remote: no NATS connect available. Register one with registerConnect().",
  );
}

const SYS_REQ_TIMEOUT = 10_000;

export interface SysOptions {
  user?: string;
  pass?: string;
  servers: string | string[];
}

export interface ServerPingVarz {
  server: { id: string; name: string; version: string };
}

// SysClient owns a lazy NATS connection to the sys account of a managed
// cluster. Used for $SYS.REQ.SERVER.* monitoring requests.
export class SysClient {
  private nc?: NatsConnection;
  private opts: SysOptions;

  constructor(opts: SysOptions) {
    this.opts = opts;
  }

  private async conn(): Promise<NatsConnection> {
    if (this.nc) return this.nc;
    const connect = await resolveConnect();
    this.nc = await connect({
      servers: this.opts.servers,
      user: this.opts.user ?? "system",
      pass: this.opts.pass ?? "password",
      name: "nst-remote-sys",
    });
    return this.nc;
  }

  close(): Promise<void> {
    if (!this.nc) return Promise.resolve();
    const nc = this.nc;
    this.nc = undefined;
    return nc.close();
  }

  // Sends a $SYS.REQ.SERVER.PING.<kind> broadcast and collects responses for
  // up to `wait` ms.
  async ping<T = unknown>(kind: string, wait = 1000): Promise<T[]> {
    const nc = await this.conn();
    const replies: T[] = [];
    const inbox = `_INBOX.${Math.random().toString(36).slice(2)}`;
    const sub = nc.subscribe(inbox);
    (async () => {
      for await (const m of sub) {
        try {
          replies.push(JSON.parse(new TextDecoder().decode(m.data)) as T);
        } catch {
          // ignore malformed
        }
      }
    })().catch(() => {});
    nc.publish(`$SYS.REQ.SERVER.PING.${kind}`, undefined, { reply: inbox });
    await new Promise((r) => setTimeout(r, wait));
    sub.unsubscribe();
    return replies;
  }

  // Targets a single server by its id. Returns the parsed JSON response,
  // unwrapping the {server, data} envelope used by $SYS.REQ.SERVER.*.
  async server<T = unknown>(
    serverId: string,
    kind: "VARZ" | "JSZ" | "CONNZ" | "LEAFZ",
    payload?: unknown,
  ): Promise<T> {
    const nc = await this.conn();
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const msg = await nc.request(
      `$SYS.REQ.SERVER.${serverId}.${kind}`,
      body,
      { timeout: SYS_REQ_TIMEOUT },
    );
    const parsed = JSON.parse(new TextDecoder().decode(msg.data)) as {
      data?: T;
      error?: { description?: string; code?: number };
    } & T;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const e = parsed.error;
      throw new Error(
        `$SYS.REQ.SERVER.${serverId}.${kind}: ${e?.code ? `[${e.code}] ` : ""}${
          e?.description ?? "request error"
        }`,
      );
    }
    if (parsed && typeof parsed === "object" && "data" in parsed) {
      return parsed.data as T;
    }
    return parsed as T;
  }
}
