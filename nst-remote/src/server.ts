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
import type { ConnZ, JSZ, ManagedServer, VarZ } from "@nats-io/nst";
import { getConnect } from "@nats-io/nst";
import { getRegisteredConnect } from "./client.ts";

async function resolveConnect(): Promise<
  (opts: ConnectionOptions) => Promise<NatsConnection>
> {
  const registered = getRegisteredConnect();
  if (registered) {
    return registered as (
      opts: ConnectionOptions,
    ) => Promise<NatsConnection>;
  }
  try {
    return getConnect() as (
      opts: ConnectionOptions,
    ) => Promise<NatsConnection>;
  } catch {
    // fallthrough
  }
  // deno-lint-ignore no-explicit-any
  if ((globalThis as any).Deno) {
    const { connect } = await import("@nats-io/transport-deno");
    return connect as unknown as (
      opts: ConnectionOptions,
    ) => Promise<NatsConnection>;
  }
  throw new Error(
    "nst-remote: no NATS connect available. Register one with registerConnect() or use @nats-io/transport-deno.",
  );
}
import { MgmtClient } from "./client.ts";
import type {
  CreateClusterRequest,
  CreateResponse,
  CreateServerRequest,
  ManagedServerInfo,
} from "./types.ts";
import { translate } from "./translate.ts";
import { SysClient } from "./sys.ts";

// Shared instance context. One per testing.go instance (server, cluster,
// super-cluster). Tracks running servers and is responsible for issuing
// tester.destroy when the last live server stops with cleanup.
class Instance {
  readonly id: string;
  readonly kind: string;
  readonly servers: Set<RemoteNatsServer> = new Set<RemoteNatsServer>();
  readonly sys: SysClient;
  private idByName: Map<string, string> = new Map<string, string>();
  destroying = false;

  constructor(id: string, kind: string, sys: SysClient) {
    this.id = id;
    this.kind = kind;
    this.sys = sys;
  }

  async resolveServerId(name: string): Promise<string> {
    const cached = this.idByName.get(name);
    if (cached) return cached;
    type PingVarz = { server: { id: string; name: string } };
    const replies = await this.sys.ping<PingVarz>("VARZ", 1500);
    for (const r of replies) {
      if (r?.server?.id && r?.server?.name) {
        this.idByName.set(r.server.name, r.server.id);
      }
    }
    const id = this.idByName.get(name);
    if (!id) {
      throw new Error(
        `nst-remote: could not resolve server id for "${name}" via $SYS.REQ.SERVER.PING.VARZ`,
      );
    }
    return id;
  }

  forgetServerId(name: string): void {
    this.idByName.delete(name);
  }
}

// Shared resources for a single mgmt URL. Holds the mgmt connection, the sys
// monitoring connection, and a name→serverId cache.
class RemoteContext {
  readonly mgmt: MgmtClient;
  private instances: Set<Instance> = new Set();

  constructor(mgmt: MgmtClient) {
    this.mgmt = mgmt;
  }

  static async open(): Promise<RemoteContext> {
    const url = mgmtURL();
    const mgmt = await MgmtClient.connect({
      url,
      user: env("NST_REMOTE_USER"),
      pass: env("NST_REMOTE_PASS"),
    });
    return new RemoteContext(mgmt);
  }

  // Creates a per-instance sys client pointed at the managed cluster's own
  // NATS endpoints (not the mgmt service's NATS).
  newInstance(id: string, kind: string, serverUrls: string[]): Instance {
    const sys = new SysClient({
      servers: serverUrls,
      user: env("NST_REMOTE_SYS_USER") ?? "system",
      pass: env("NST_REMOTE_SYS_PASS") ?? "password",
    });
    const inst = new Instance(id, kind, sys);
    this.instances.add(inst);
    return inst;
  }

  retireInstance(inst: Instance): Promise<void> {
    this.instances.delete(inst);
    return inst.sys.close();
  }

  async close(): Promise<void> {
    for (const inst of this.instances) {
      await inst.sys.close();
    }
    this.instances.clear();
    await this.mgmt.close();
  }
}

let ctxPromise: Promise<RemoteContext> | undefined;
export function context(): Promise<RemoteContext> {
  if (!ctxPromise) ctxPromise = RemoteContext.open();
  return ctxPromise;
}

// Close the shared management / sys connections. Call from test teardown
// to satisfy Deno resource sanitizer.
export async function closeRemoteContext(): Promise<void> {
  if (!ctxPromise) return;
  const ctx = await ctxPromise;
  ctxPromise = undefined;
  await ctx.close();
}

function env(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  return g.Deno?.env?.get?.(name) ?? g.process?.env?.[name];
}

function mgmtURL(): string {
  const u = env("NST_REMOTE_URL");
  if (!u) {
    throw new Error(
      "nst-remote: NST_REMOTE_URL is not set — set it to the management service NATS URL",
    );
  }
  return u;
}

// RemoteNatsServer is the per-server handle returned from the factory.
// Implements ManagedServer so it is interchangeable with the local
// nst NatsServer at the public-surface level.
export class RemoteNatsServer implements ManagedServer {
  hostname: string;
  port: number;
  monitoring?: number;
  websocket?: number;
  cluster?: number;
  clusterName?: string;

  // Optional auxiliary listener ports keyed by snippet name.
  readonly ports: Record<string, number>;

  // Mirrors local NatsServer.config — exposed for tests that consult it.
  config: { server_name: string };

  certsDir?: string;

  private ctx: RemoteContext;
  private instance: Instance;
  private name: string;
  private url?: string;
  private serverId?: string;
  private stopped = false;

  constructor(
    ctx: RemoteContext,
    instance: Instance,
    info: ManagedServerInfo,
  ) {
    this.ctx = ctx;
    this.instance = instance;
    this.name = info.name;
    this.port = info.port;
    this.url = info.url;
    this.ports = info.ports ?? {};
    this.hostname = parseHost(info.url) ?? "127.0.0.1";
    this.monitoring = this.ports.monitoring;
    this.websocket = this.ports.websocket;
    this.cluster = this.ports.cluster;
    this.clusterName = info.cluster || undefined;
    this.config = { server_name: info.name };
    instance.servers.add(this);
  }

  // ------------------------------------------------------------------
  // ManagedServer impl
  // ------------------------------------------------------------------

  async connect(opts: ConnectionOptions = {}): Promise<NatsConnection> {
    const connect = await resolveConnect();
    const merged: ConnectionOptions = { ...opts };
    if (!merged.servers && !merged.port) {
      merged.servers = this.url ?? `${this.hostname}:${this.port}`;
    }
    // Only inject default creds when the caller hasn't supplied any auth
    // mechanism. Tests passing user/pass, token, or a custom authenticator
    // own the auth flow entirely.
    const hasAuth =
      // deno-lint-ignore no-explicit-any
      !!(merged.user || (merged as any).pass || (merged as any).token ||
        // deno-lint-ignore no-explicit-any
        (merged as any).authenticator);
    if (!hasAuth) {
      merged.user = env("NST_REMOTE_USER") ?? "user1";
      // deno-lint-ignore no-explicit-any
      (merged as any).pass = env("NST_REMOTE_PASS") ?? "password";
    }
    return connect(merged);
  }

  async varz(): Promise<VarZ> {
    const id = await this.id();
    return this.instance.sys.server<VarZ>(id, "VARZ");
  }

  async jsz(): Promise<JSZ> {
    const id = await this.id();
    return this.instance.sys.server<JSZ>(id, "JSZ");
  }

  async connz(
    cid?: number,
    subs: boolean | "detail" = true,
  ): Promise<ConnZ> {
    const id = await this.id();
    const payload: Record<string, unknown> = {
      subscriptions: subs !== false,
      subscriptions_detail: subs === "detail",
    };
    if (cid !== undefined) payload.cid = cid;
    return this.instance.sys.server<ConnZ>(id, "CONNZ", payload);
  }

  async leafz(): Promise<{ leafs: unknown[]; leafnodes: number }> {
    const id = await this.id();
    return this.instance.sys.server(id, "LEAFZ");
  }

  async stop(cleanup = false): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.instance.servers.delete(this);
    if (cleanup) {
      if (this.instance.servers.size === 0 && !this.instance.destroying) {
        this.instance.destroying = true;
        try {
          await this.ctx.mgmt.destroy(this.instance.id);
        } finally {
          await this.ctx.retireInstance(this.instance);
        }
      }
      return;
    }
    await this.ctx.mgmt.stopServer(this.name);
  }

  async restart(): Promise<RemoteNatsServer> {
    if (!this.stopped) {
      await this.ctx.mgmt.stopServer(this.name);
    }
    await this.ctx.mgmt.startServer(this.name);
    const status = await this.ctx.mgmt.status(this.instance.id);
    const inst = status.instances.find((i) => i.id === this.instance.id);
    const info = inst?.servers.find((s) => s.name === this.name);
    if (info) {
      this.port = info.port;
      this.url = info.url;
      if (info.ports) {
        for (const k of Object.keys(this.ports)) delete this.ports[k];
        for (const [k, v] of Object.entries(info.ports)) this.ports[k] = v;
        this.monitoring = this.ports.monitoring;
        this.websocket = this.ports.websocket;
        this.cluster = this.ports.cluster;
      }
    }
    this.instance.forgetServerId(this.name);
    this.serverId = undefined;
    this.stopped = false;
    return this;
  }

  signal(_sig: string): Promise<void> {
    return Promise.reject(
      new Error("signal() is not supported by nst-remote"),
    );
  }

  reload(_conf: unknown): Promise<void> {
    return Promise.reject(
      new Error("reload() is not supported by nst-remote"),
    );
  }

  getLog(): string {
    throw new Error("getLog() is not supported by nst-remote");
  }

  pid(): number {
    throw new Error("pid() is not supported by nst-remote");
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop(true);
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async id(): Promise<string> {
    if (this.serverId) return this.serverId;
    this.serverId = await this.instance.resolveServerId(this.name);
    return this.serverId;
  }
}

function parseHost(url?: string): string | undefined {
  if (!url) return undefined;
  const s = url.includes("://") ? url.split("://")[1] : url;
  const host = s.split(":")[0];
  return host || undefined;
}

// ----------------------------------------------------------------------
// Static factory — mirrors NatsServer.start / .cluster / etc.
// ----------------------------------------------------------------------

export class NatsServer extends RemoteNatsServer {
  static async start(
    conf?: unknown,
    _debug?: boolean,
  ): Promise<NatsServer> {
    const ctx = await context();
    const t = translate(
      conf as Record<string, unknown> | undefined,
      "server",
    );
    const req: CreateServerRequest = {
      jetstream: t.jetstream,
      snippets: t.snippets,
      template: t.template,
    };
    const resp = await ctx.mgmt.createServer(req);
    const instance = ctx.newInstance(
      resp.id,
      resp.kind,
      serverUrls(resp.servers),
    );
    const info = resp.servers[0];
    return new NatsServer(ctx, instance, info);
  }

  static async cluster(
    count = 2,
    conf?: unknown,
    _debug?: boolean,
  ): Promise<NatsServer[]> {
    return await createClusterShared(count, conf, false);
  }

  static async jetstreamCluster(
    count = 3,
    conf?: unknown,
    _debug?: boolean,
  ): Promise<NatsServer[]> {
    return await createClusterShared(count, conf, true);
  }

  static setupDataConnCluster(
    _count = 4,
    _debug?: boolean,
  ): Promise<NatsServer[]> {
    return Promise.reject(
      new Error("setupDataConnCluster() not implemented yet on nst-remote"),
    );
  }

  static addClusterMember(
    _ns: ManagedServer,
    _conf?: unknown,
    _debug?: boolean,
  ): Promise<NatsServer> {
    return Promise.reject(
      new Error(
        "addClusterMember() not supported by nst-remote — use local @nats-io/nst",
      ),
    );
  }

  static stopAll(
    cluster: ManagedServer[],
    cleanup = false,
  ): Promise<void[]> {
    return Promise.all(cluster.map((s) => s.stop(cleanup)));
  }

  static localClusterFormed(_servers: ManagedServer[]): Promise<void[]> {
    return Promise.resolve([]);
  }

  static dataClusterFormed(
    proms: Promise<ManagedServer>[],
    _debug?: boolean,
  ): Promise<ManagedServer[]> {
    return Promise.all(proms);
  }

  static tlsConfig(): Promise<{
    tls: { cert_file: string; key_file: string; ca_file: string };
    certsDir: string;
  }> {
    return Promise.reject(
      new Error("tlsConfig() not implemented yet on nst-remote"),
    );
  }
}

async function createClusterShared(
  count: number,
  conf: unknown,
  jetstream: boolean,
): Promise<NatsServer[]> {
  const ctx = await context();
  const t = translate(
    conf as Record<string, unknown> | undefined,
    "cluster",
  );
  const req: CreateClusterRequest = {
    servers: count,
    jetstream: jetstream || t.jetstream,
    snippets: t.snippets,
    template: t.template,
  };
  const resp: CreateResponse = await ctx.mgmt.createCluster(req);
  const instance = ctx.newInstance(
    resp.id,
    resp.kind,
    serverUrls(resp.servers),
  );
  return resp.servers.map((info) => new NatsServer(ctx, instance, info));
}

function serverUrls(servers: ManagedServerInfo[]): string[] {
  return servers
    .map((s) => s.url ?? `nats://127.0.0.1:${s.port}`)
    .filter((u): u is string => !!u);
}
