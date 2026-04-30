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
// deno-lint-ignore-file no-explicit-any
import { join, resolve } from "node:path";
import { connect as netConnect } from "node:net";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { check, jsopts } from "./mod.ts";
import { type SpawnedProc, spawnServer } from "./process_runtime.ts";
import {
  type ConnectionOptions,
  delay,
  type NatsConnection,
  nuid,
  wsconnect,
} from "@nats-io/nats-core/internal";
import { Certs } from "./certs.ts";
import { getConnect } from "./connect.ts";

export const ServerSignals = {
  QUIT: "SIGQUIT",
  STOP: "SIGSTOP",
  REOPEN: "SIGUSR1",
  RELOAD: "SIGHUP",
  LDM: "SIGUSR2",
  KILL: "SIGKILL",
} as const;

const WS_ENV = "websocket";
const MAX_LOG_BYTES = 4 * 1024 * 1024;

export interface PortInfo {
  clusterName?: string;
  hostname: string;
  port: number;
  cluster?: number;
  monitoring?: number;
  websocket?: number;
}

export interface Ports {
  nats: string[];
  cluster?: string[];
  monitoring?: string[];
  websocket?: string[];
}

export interface VarZ {
  "connect_urls": string[];
}

export interface JSZ {
  "server_id": string;
  now: string;
  config: {
    "max_memory": number;
    "max_storage": number;
    "store_dir": string;
  };
  memory: number;
  storage: number;
  api: { total: number; errors: number };
  "current_api_calls": number;
  "meta_cluster": {
    name: string;
    leader: string;
    replicas: [{ name: string; current: boolean; active: number }];
  };
}

export interface SubDetails {
  subject: string;
  sid: string;
  msgs: number;
  cid: number;
}

export interface Conn {
  cid: number;
  kind: string;
  type: string;
  ip: string;
  port: number;
  start: string;
  "last_activity": string;
  "rtt": string;
  uptime: string;
  idle: string;
  "pending_bytes": number;
  "in_msgs": number;
  "out_msgs": number;
  "in_bytes": number;
  "out_bytes": number;
  subscriptions: number;
  name: string;
  lang: string;
  version: string;
  subscriptions_list?: string[];
  subscriptions_list_detail?: SubDetails[];
}

export interface ConnZ {
  "server_id": string;
  now: string;
  "num_connections": number;
  "total": number;
  "offset": number;
  "limit": number;
  "connections": Conn[];
}

function parseHostport(
  s?: string,
): { hostname: string; port: number } | undefined {
  if (!s) {
    return;
  }
  const idx = s.indexOf("://");
  if (idx !== -1) {
    s = s.slice(idx + 3);
  }
  const [hostname, ps] = s.split(":");
  const port = parseInt(ps, 10);

  return { hostname, port };
}

function parsePorts(ports: Ports): PortInfo {
  ports.monitoring = ports.monitoring || [];
  ports.cluster = ports.cluster || [];
  ports.websocket = ports.websocket || [];
  const listen = parseHostport(ports.nats[0]);
  const p: PortInfo = {} as PortInfo;

  if (listen) {
    p.hostname = listen.hostname;
    p.port = listen.port;
  }

  p.cluster = parseHostport(ports.cluster[0])?.port;
  p.monitoring = parseHostport(ports.monitoring[0])?.port;
  p.websocket = parseHostport(ports.websocket[0])?.port;

  return p;
}

function rgb24(s: string, c: { r: number; g: number; b: number }): string {
  return `\x1b[38;2;${c.r};${c.g};${c.b}m${s}\x1b[0m`;
}

export class NatsServer implements PortInfo {
  hostname: string;
  clusterName?: string;
  port: number;
  cluster?: number;
  monitoring?: number;
  websocket?: number;
  process: SpawnedProc;
  logBuffer: string[] = [];
  logBytes = 0;
  stopped = false;
  debug: boolean;
  config: any;
  configFile: string;
  rgb: { r: number; g: number; b: number };

  constructor(opts: {
    info: PortInfo;
    process: SpawnedProc;
    debug?: boolean;
    config: any;
    configFile: string;
  }) {
    const { info, process: proc, debug, config, configFile } = opts;
    this.hostname = info.hostname;
    this.port = info.port;
    this.cluster = info.cluster;
    this.monitoring = info.monitoring;
    this.websocket = info.websocket;
    this.clusterName = info.clusterName;
    this.process = proc;
    this.debug = debug || false;
    this.config = config;
    this.configFile = configFile;

    const r = Math.floor(Math.random() * 255);
    const g = Math.floor(Math.random() * 255);
    const b = Math.floor(Math.random() * 255);
    this.rgb = { r, g, b };

    const td = new TextDecoder();
    proc.onStderr((chunk) => {
      const t = td.decode(chunk);
      this.logBuffer.push(t);
      this.logBytes += t.length;
      while (this.logBytes > MAX_LOG_BYTES && this.logBuffer.length > 1) {
        const dropped = this.logBuffer.shift()!;
        this.logBytes -= dropped.length;
      }
      if (debug) {
        console.log(rgb24(t.slice(0, t.length - 1), this.rgb));
      }
    });
  }

  updatePorts(): Promise<void> {
    this.config.port = this.port;
    if (this.cluster) {
      this.config.cluster.listen = `${this.hostname}:${this.cluster}`;
      this.config.cluster.name = this.clusterName;
    }
    if (this.monitoring) {
      this.config.http = this.monitoring;
    }
    if (this.websocket) {
      this.config.websocket = this.config.websocket || {};
      this.config.websocket.port = this.websocket;
    }
    return writeFile(this.configFile, toConf(this.config), "utf-8");
  }

  async restart(): Promise<NatsServer> {
    await this.stop();
    return NatsServer.start(structuredClone(this.config), this.debug);
  }

  pid(): number {
    return this.process.pid ?? -1;
  }

  getLog(): string {
    return this.logBuffer.join("");
  }

  static stopAll(cluster: NatsServer[], cleanup = false): Promise<void[]> {
    const buf: Promise<void>[] = [];
    cluster.forEach((s) => {
      s === null ? buf.push(Promise.resolve()) : buf.push(s?.stop(cleanup));
    });

    return Promise.all(buf);
  }

  rmPortsFile(): Promise<void> {
    const portsFile = resolve(
      join(tmpdir(), `nats-server_${this.pid()}.ports`),
    );
    return rm(portsFile, { force: true });
  }

  rmConfigFile(): Promise<void> {
    return rm(this.configFile, { force: true });
  }

  rmDataDir(): Promise<void> {
    const dir = this.config?.jetstream?.store_dir;
    if (typeof dir === "string") {
      return rm(dir, { recursive: true, force: true });
    }
    return Promise.resolve();
  }

  async stop(cleanup = false): Promise<void> {
    if (!this.stopped) {
      await this.updatePorts();
      this.stopped = true;
      await this.process.closeStderr();
      this.process.kill(ServerSignals.KILL);
    }
    await this.process.exited();
    const cleanups = [this.rmPortsFile(), this.rmConfigFile()];
    if (cleanup) cleanups.push(this.rmDataDir());
    await Promise.all(cleanups);
  }

  signal(signal: string): Promise<void> {
    if (signal === ServerSignals.KILL) {
      return this.stop();
    }
    this.process.kill(signal);
    return Promise.resolve();
  }

  async varz(): Promise<VarZ> {
    if (!this.monitoring) {
      return Promise.reject(new Error("server is not monitoring"));
    }
    const resp = await fetch(`http://127.0.0.1:${this.monitoring}/varz`);
    return await resp.json();
  }

  async jsz(): Promise<JSZ> {
    if (!this.monitoring) {
      return Promise.reject(new Error("server is not monitoring"));
    }
    const resp = await fetch(`http://127.0.0.1:${this.monitoring}/jsz`);
    return await resp.json();
  }

  async leafz(): Promise<{ leafs: unknown[]; leafnodes: number }> {
    if (!this.monitoring) {
      return Promise.reject(new Error("server is not monitoring"));
    }
    const resp = await fetch(`http://127.0.0.1:${this.monitoring}/leafz`);
    return await resp.json();
  }

  async connz(cid?: number, subs: boolean | "detail" = true): Promise<ConnZ> {
    if (!this.monitoring) {
      return Promise.reject(new Error("server is not monitoring"));
    }
    const args: string[] = [];
    args.push(`subs=${subs}`);
    if (cid) {
      args.push(`cid=${cid}`);
    }

    const resp = await fetch(
      `http://127.0.0.1:${this.monitoring}/connz?${args.join("&")}`,
    );
    return await resp.json();
  }

  async dataDir(): Promise<string | null> {
    const jsz = await this.jsz();
    return jsz.config.store_dir;
  }

  /**
   * Setup a cluster that has N nodes with the first node being just a connection
   * server - rest are JetStream.
   * @param count
   * @param debug
   */
  static async setupDataConnCluster(
    count = 4,
    debug = false,
  ): Promise<NatsServer[]> {
    if (count < 4) {
      return Promise.reject(new Error("data cluster must be 4 or greater"));
    }
    let servers = await NatsServer.jetstreamCluster(count, {}, debug);
    await NatsServer.stopAll(servers);
    await Promise.all(servers.map((s) => s.rmDataDir()));
    servers[0].config.jetstream = "disabled";
    const proms = servers.map((s) => {
      return s.restart();
    });
    servers = await Promise.all(proms);
    await NatsServer.dataClusterFormed(proms.slice(1));
    return servers;
  }

  static async jetstreamCluster(
    count = 3,
    serverConf?: Record<string, unknown>,
    debug = false,
  ): Promise<NatsServer[]> {
    serverConf = serverConf || {};
    const js = serverConf.jetstream as {
      max_file_store?: number;
      max_mem_store?: number;
    };
    if (js) {
      delete serverConf.jetstream;
    }
    const servers = await NatsServer.cluster(count, serverConf, debug);

    const configs = servers.map((s) => {
      const { port, cluster, monitoring, websocket, config } = s;
      return { port, cluster, monitoring, websocket, config };
    });

    const proms = servers.map((s) => {
      return s.stop();
    });
    await Promise.all(proms);

    servers.forEach((s) => {
      s.debug = debug;
    });

    const routes: string[] = [];
    configs.forEach((conf) => {
      const { cluster, config } = conf;

      const { jetstream } = jsopts() as { jetstream: any };
      if (js) {
        if (js.max_file_store !== undefined) {
          jetstream.max_file_store = js.max_file_store;
        }
        if (js.max_mem_store !== undefined) {
          jetstream.max_mem_store = js.max_mem_store;
        }
      }
      Object.assign(config, { jetstream, server_name: nuid.next() });

      config.cluster.listen = config.cluster.listen.replace("-1", `${cluster}`);
      routes.push(`nats://${config.cluster.listen}`);
    });

    configs.forEach((c) => {
      c.config.cluster.routes = routes.filter((v) => {
        return v.indexOf(c.config.cluster.listen) === -1;
      });
    });
    servers.forEach((s, idx) => {
      s.config = configs[idx].config;
    });

    const buf: Promise<NatsServer>[] = [];
    servers.map((s) => {
      buf.push(s.restart());
    });

    return NatsServer.dataClusterFormed(buf, debug);
  }

  static async dataClusterFormed(
    proms: Promise<NatsServer>[],
    debug = false,
  ): Promise<NatsServer[]> {
    let errs = 0;
    let servers: NatsServer[] = [];
    const statusProms: Promise<JSZ>[] = [];
    const leaders: string[] = [];
    while (true) {
      try {
        leaders.length = 0;
        statusProms.length = 0;
        servers = await Promise.all(proms);
        servers.forEach((s) => {
          statusProms.push(s.jsz());
        });

        const status = await Promise.all(statusProms);
        status.forEach((i) => {
          const leader = i.meta_cluster.leader;
          if (leader) {
            leaders.push(leader);
          }
        });
        if (leaders.length === proms.length) {
          const u = leaders.filter((v, idx, a) => {
            return a.indexOf(v) === idx;
          });
          if (u.length === 1) {
            const leader = servers.filter((s) => {
              return s.config.server_name === u[0];
            });
            const n = rgb24(`${u[0]}`, leader[0].rgb);
            if (debug) {
              console.log(`leader consensus ${n}`);
            }
            return servers;
          } else {
            if (debug) {
              console.log(
                `leader contention ${leaders.length}`,
              );
            }
          }
        } else {
          if (debug) {
            console.log(
              `found ${leaders.length}/${servers.length} leaders`,
            );
          }
        }
      } catch (err) {
        errs++;
        if (errs > 10) {
          throw err;
        }
      }
      await delay(250);
    }
  }

  static async cluster(
    count = 2,
    conf?: any,
    debug = false,
  ): Promise<NatsServer[]> {
    conf = conf || {};
    conf = Object.assign({}, conf);
    conf.cluster = conf.cluster || {};
    conf.cluster.name = "C_" + nuid.next();
    conf.cluster.listen = conf.cluster.listen || "127.0.0.1:-1";

    const ns = await NatsServer.start(conf, debug);
    const cluster = [ns];

    for (let i = 1; i < count; i++) {
      const c = Object.assign({}, conf);
      const s = await NatsServer.addClusterMember(ns, c, debug);
      cluster.push(s);
    }
    return cluster;
  }

  static localClusterFormed(servers: NatsServer[]): Promise<void[]> {
    const ports = servers.map((s) => s.port);

    const deadline = Date.now() + 5000;
    const fn = async function (s: NatsServer) {
      while (Date.now() < deadline) {
        const data = await s.varz();
        if (data) {
          const urls = data.connect_urls as string[];
          const others = urls.map((u) => parseHostport(u)?.port);
          if (others.every((v) => ports.includes(v!))) {
            return;
          }
        }
        await delay(100);
      }
      throw new Error(`${s.hostname}:${s.port} failed to resolve peers`);
    };
    const proms = servers.map((s) => fn(s));
    return Promise.all(proms);
  }

  static addClusterMember(
    ns: NatsServer,
    conf?: any,
    debug = false,
  ): Promise<NatsServer> {
    if (ns.cluster === undefined) {
      return Promise.reject(new Error("no cluster port on server"));
    }
    conf = structuredClone(conf || {});
    conf.port = -1;
    if (conf.websocket) {
      conf.websocket.port = -1;
    }
    conf.http = "127.0.0.1:-1";
    conf.cluster = conf.cluster || {};
    conf.cluster.name = ns.clusterName;
    conf.cluster.listen = "127.0.0.1:-1";
    conf.cluster.routes = [`nats://${ns.hostname}:${ns.cluster}`];
    return NatsServer.start(conf, debug);
  }

  static confDefaults(conf?: any): any {
    conf = conf || {};
    conf.host = conf.host || "127.0.0.1";
    conf.port = conf.port || -1;
    conf.http = conf.http || "127.0.0.1:-1";
    conf.leafnodes = conf.leafnodes || {};
    conf.leafnodes.listen = conf.leafnodes.listen || "127.0.0.1:-1";
    conf.server_tags = Array.isArray(conf.server_tags)
      ? [...conf.server_tags, `id:${nuid.next()}`]
      : [`id:${nuid.next()}`];

    conf.websocket = Object.assign(
      {},
      { port: -1, no_tls: true },
      conf.websocket || {},
    );

    return conf;
  }

  /**
   * this is only expecting authentication type changes
   * @param conf
   */
  async reload(conf?: any): Promise<void> {
    conf.host = this.config.host;
    conf.port = this.config.port;
    conf.http = this.config.http;
    conf.websocket = this.config.websocket;
    conf.leafnodes = this.config.leafnodes;
    conf = Object.assign(this.config, conf);
    await writeFile(this.configFile, toConf(conf), "utf-8");
    return this.signal(ServerSignals.RELOAD);
  }

  static async tlsConfig(): Promise<
    {
      tls: { cert_file: string; key_file: string; ca_file: string };
      certsDir: string;
    }
  > {
    const certsDir = await mkdtemp(join(tmpdir(), "certs"));
    const certs = await Certs.import();
    await certs.store(certsDir);
    const tlsconfig = {
      certsDir,
      tls: {
        cert_file: resolve(join(certsDir, "localhost.crt")),
        key_file: resolve(join(certsDir, "localhost.key")),
        ca_file: resolve(join(certsDir, "RootCA.crt")),
      },
    };
    return tlsconfig;
  }

  connect(opts: ConnectionOptions = {}): Promise<NatsConnection> {
    if (process.env[WS_ENV]) {
      const proto = this.config.websocket.no_tls ? "ws" : "wss";
      opts.servers = `${proto}://localhost:${this.websocket}`;
      return wsconnect(opts);
    }
    opts.port = this.port;
    return getConnect()(opts);
  }

  static async start(conf?: any, debug = false): Promise<NatsServer> {
    const exe = "nats-server";
    const tmp = resolve(tmpdir());
    conf = NatsServer.confDefaults(conf);
    conf.ports_file_dir = tmp;

    const tmpDir = await mkdtemp(join(tmp, "nats-server_"));
    const confFile = join(tmpDir, `${nuid.next()}.conf`);
    await writeFile(confFile, toConf(conf), "utf-8");
    if (debug) {
      console.info(`${exe} -c ${confFile}`);
    }

    let srv: SpawnedProc;
    try {
      srv = spawnServer(exe, ["-c", confFile]);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        throw new Error(
          `nats-server not found on PATH (tried "${exe}"). Install: https://github.com/nats-io/nats-server/releases`,
        );
      }
      throw err;
    }

    if (srv.pid && debug) {
      console.info(`config: ${confFile}`);
      console.info(`[${srv.pid}] - launched`);
    }

    const portsFile = resolve(
      join(tmp, `nats-server_${srv.pid}.ports`),
    );

    const pi = await check(
      () => {
        try {
          const txt = readFileSync(portsFile, "utf-8");
          const d = JSON.parse(txt);
          if (d) {
            return d;
          }
        } catch (_) {
          // ignore
        }
      },
      5000,
      { name: `read ports file ${portsFile} - ${confFile}` },
    );

    if (debug) {
      console.info(`[${srv.pid}] - ports file found`);
    }

    const ports = parsePorts(pi as Ports);
    if (conf.cluster?.name) {
      ports.clusterName = conf.cluster.name;
    }

    try {
      await check(
        () => {
          return new Promise<number | undefined>((resolve) => {
            if (debug) {
              console.info(`[${srv.pid}] - attempting to connect`);
            }
            const sock = netConnect(ports.port, ports.hostname);
            const done = (v: number | undefined) => {
              sock.removeAllListeners();
              sock.destroy();
              resolve(v);
            };
            sock.once("connect", () => done(ports.port));
            sock.once("error", () => done(undefined));
            sock.setTimeout(500, () => done(undefined));
          });
        },
        5000,
        { name: "wait for server" },
      );

      return new NatsServer(
        {
          info: ports,
          process: srv,
          debug: debug,
          config: conf,
          configFile: confFile,
        },
      );
    } catch (err) {
      console.error(`failed to start config: ${confFile}`);
      await srv.closeStderr();
      srv.kill(ServerSignals.KILL);
      await srv.exited();
      throw err;
    }
  }
}

export function toConf(o: any, indent?: string): string {
  const pad = indent !== undefined ? indent + "  " : "";
  const buf: string[] = [];
  for (const k in o) {
    if (Object.prototype.hasOwnProperty.call(o, k)) {
      const v = o[k];
      if (Array.isArray(v)) {
        buf.push(`${pad}${k} [`);
        buf.push(toConf(v, pad));
        buf.push(`${pad} ]`);
      } else if (typeof v === "object") {
        const kn = Array.isArray(o) ? "" : k;
        buf.push(`${pad}${kn} {`);
        buf.push(toConf(v, pad));
        buf.push(`${pad} }`);
      } else {
        if (!Array.isArray(o)) {
          if (
            typeof v === "string" && v.startsWith("$")
          ) {
            buf.push(`${pad}${k}: "${v}"`);
          } else if (
            typeof v === "string" && v.charAt(0) >= "0" && v.charAt(0) <= "9"
          ) {
            buf.push(`${pad}${k}: "${v}"`);
          } else {
            buf.push(`${pad}${k}: ${v}`);
          }
        } else {
          if (
            v.includes(" ") || v.startsWith("$") ||
            (v.includes("{{") && v.includes("}"))
          ) {
            buf.push(`${pad}"${v}"`);
          } else {
            buf.push(pad + v);
          }
        }
      }
    }
  }
  return buf.join("\n");
}
