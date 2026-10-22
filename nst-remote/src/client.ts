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
import { wsconnect } from "@nats-io/nats-core";
import type {
  CreateClusterRequest,
  CreateResponse,
  CreateServerRequest,
  CreateSuperClusterRequest,
  DestroyResponse,
  ListResponse,
  ResetResponse,
  StartServerResponse,
  StatusResponse,
  StopServerResponse,
} from "./types.ts";
import { TesterSubjects } from "./types.ts";

const DEFAULT_TIMEOUT = 30_000;

export interface MgmtClientOptions {
  url: string;
  user?: string;
  pass?: string;
  timeout?: number;
}

// MgmtClient owns a NATS connection to the testing.go management service and
// issues request/reply against tester.* subjects.
export class MgmtClient {
  private constructor(
    private nc: NatsConnection,
    private timeout: number,
  ) {}

  static async connect(opts: MgmtClientOptions): Promise<MgmtClient> {
    const connectFn = await loadCoreConnect(opts.url);
    const nc = await connectFn({
      servers: opts.url,
      user: opts.user,
      pass: opts.pass,
      name: "nst-remote-mgmt",
    });
    return new MgmtClient(nc, opts.timeout ?? DEFAULT_TIMEOUT);
  }

  close(): Promise<void> {
    return this.nc.close();
  }

  createServer(req: CreateServerRequest): Promise<CreateResponse> {
    return this.request<CreateResponse>(TesterSubjects.createServer, req);
  }

  createCluster(req: CreateClusterRequest): Promise<CreateResponse> {
    return this.request<CreateResponse>(TesterSubjects.createCluster, req);
  }

  createSuperCluster(
    req: CreateSuperClusterRequest,
  ): Promise<CreateResponse> {
    return this.request<CreateResponse>(
      TesterSubjects.createSuperCluster,
      req,
    );
  }

  destroy(instanceId: string): Promise<DestroyResponse> {
    return this.request<DestroyResponse>(TesterSubjects.destroy, {
      instance_id: instanceId,
    });
  }

  stopServer(name: string): Promise<StopServerResponse> {
    return this.request<StopServerResponse>(TesterSubjects.stopServer, {
      name,
    });
  }

  startServer(name: string): Promise<StartServerResponse> {
    return this.request<StartServerResponse>(TesterSubjects.startServer, {
      name,
    });
  }

  list(): Promise<ListResponse> {
    return this.request<ListResponse>(TesterSubjects.list, {});
  }

  status(instanceId?: string): Promise<StatusResponse> {
    return this.request<StatusResponse>(TesterSubjects.status, {
      instance_id: instanceId,
    });
  }

  reset(): Promise<ResetResponse> {
    return this.request<ResetResponse>(TesterSubjects.reset, {});
  }

  private async request<T>(subject: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload);
    const msg = await this.nc.request(subject, body, {
      timeout: this.timeout,
    });
    const errHeader = msg.headers?.get("Nats-Service-Error");
    if (errHeader) {
      const code = msg.headers?.get("Nats-Service-Error-Code");
      throw new Error(
        `${subject}: ${code ? `[${code}] ` : ""}${errHeader}`,
      );
    }
    const text = new TextDecoder().decode(msg.data);
    if (!text.length) {
      return undefined as T;
    }
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const e = parsed as { error: string; code?: string };
      throw new Error(
        `${subject}: ${e.code ? `[${e.code}] ` : ""}${e.error}`,
      );
    }
    return parsed as T;
  }
}

// Lazy-load the core connect. Order:
//   1. ws/wss URL → wsconnect from core
//   2. nst-remote's own registered connect (via registerConnect)
//   3. Under Deno, default to @nats-io/transport-deno so tests that don't
//      explicitly bootstrap a transport still work
async function loadCoreConnect(
  url: string,
): Promise<
  (opts: Record<string, unknown>) => Promise<NatsConnection>
> {
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return wsconnect as unknown as (
      opts: Record<string, unknown>,
    ) => Promise<NatsConnection>;
  }
  const registered = getRegisteredConnect();
  if (registered) {
    return registered as (
      opts: Record<string, unknown>,
    ) => Promise<NatsConnection>;
  }
  // deno-lint-ignore no-explicit-any
  if ((globalThis as any).Deno) {
    // @ts-ignore — Deno-only dep, not resolvable from a Node tsc build.
    const { connect } = await import("@nats-io/transport-deno");
    return connect as unknown as (
      opts: Record<string, unknown>,
    ) => Promise<NatsConnection>;
  }
  throw new Error(
    "nst-remote: no NATS connect available. Register one with registerConnect() or use @nats-io/transport-deno.",
  );
}

// deno-lint-ignore no-explicit-any
type ConnectFn = (opts: any) => Promise<NatsConnection>;

let _connect: ConnectFn | undefined;

export function registerConnect(fn: ConnectFn): void {
  _connect = fn;
}

export function getRegisteredConnect(): ConnectFn | undefined {
  return _connect;
}
