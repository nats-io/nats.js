/*
 * Copyright 2020-2024 The NATS Authors
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
import { join, resolve } from "jsr:@std/path";
import { rgb24 } from "jsr:@std/fmt/colors";
import { check, jsopts } from "./mod.ts";
import { extend, timeout } from "../core/src/util.ts";
import type { Deferred } from "../core/src/util.ts";
import { deferred, delay, nuid } from "../core/src/mod.ts";
import { Certs } from "./certs.ts";

export const ServerSignals = Object.freeze({
  QUIT: "SIGQUIT",
  STOP: "SIGSTOP",
  REOPEN: "SIGUSR1",
  RELOAD: "SIGHUP",
  LDM: "SIGUSR2",
});

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
  if (idx) {
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

  const cluster = ports.cluster.map((v) => {
    if (v) {
      return parseHostport(v)?.port;
    }
    return undefined;
  });
  p.cluster = cluster[0];

  const monitoring = ports.monitoring.map((v) => {
    if (v) {
      return parseHostport(v)?.port;
    }
    return undefined;
  });
  p.monitoring = monitoring[0];

  const websocket = ports.websocket.map((v) => {
    if (v) {
      return parseHostport(v)?.port;
    }
    return undefined;
  });
  p.websocket = websocket[0];

  return p;
}

export class NatsServer implements PortInfo {
  hostname: string;
  clusterName?: string;
  port: number;
  cluster?: number;
  monitoring?: number;
  websocket?: number;
  process: Deno.ChildProcess;
  logBuffer: string[] = [];
  stopped = false;
  done!: Deferred<void>;
  debug: boolean;
  config: any;
  configFile: string;
  rgb: { r: number; g: number; b: number };

  constructor(opts: {
    info: PortInfo;
    process: Deno.ChildProcess;
    debug?: boolean;
    config: any;
    configFile: string;
  }) {
    const { info, process, debug, config, configFile } = opts;
    this.hostname = info.hostname;
    this.port = info.port;
    this.cluster = info.cluster;
    this.monitoring = info.monitoring;
    this.websocket = info.websocket;
    this.clusterName = info.clusterName;
    this.process = process;
    this.debug = debug || false;
    this.done = deferred<void>();
    this.config = config;
    this.configFile = configFile;

    const r = Math.floor(Math.random() * 255);
    const g = Math.floor(Math.random() * 255);
    const b = Math.floor(Math.random() * 255);
    this.rgb = { r, g, b };

    (async () => {
      const td = new TextDecoder();
      const reader = process.stderr.getReader();

      while (true) {
        try {
          const results = await reader.read();
          if (results.done) {
            break;
          }

          if (results.value) {
            const t = td.decode(results.value);
            this.logBuffer.push(t);
            if (debug) {
              console.log(rgb24(t.slice(0, t.length - 1), this!.rgb));
            }
          }
        } catch (_err) {
          break;
        }
      }
      this.done.resolve();
    })();
  }

  updatePorts(): Promise<void> {
    // if we have -1 ports, lets freeze them
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
    return Deno.writeFile(
      this.configFile,
      new TextEncoder().encode(toConf(this.config)),
    );
  }

  async restart(): Promise<NatsServer> {
    await this.stop();
    const conf = JSON.parse(JSON.stringify(this.config));
    return await NatsServer.start(conf, this.debug);
  }

  pid(): number {
    return this.process.pid;
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

  rmPortsFile() {
    const tmp = resolve(Deno.env.get("TMPDIR") || ".");
    const portsFile = resolve(
      join(tmp, `nats-server_${this.pid()}.ports`),
    );
    try {
      Deno.statSync(portsFile);
      Deno.removeSync(portsFile);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        console.log((err as Error).message);
      }
    }
  }

  rmConfigFile() {
    try {
      Deno.removeSync(this.configFile);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        console.log((err as Error).message);
      }
    }
  }

  rmDataDir() {
    if (typeof this.config?.jetstream?.store_dir === "string") {
      try {
        Deno.removeSync(this.config.jetstream.store_dir, { recursive: true });
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          console.log((err as Error).message);
        }
      }
    }
  }

  async stop(cleanup = false): Promise<void> {
    if (!this.stopped) {
      await this.updatePorts();
      this.stopped = true;
      this.process.stderr?.cancel().catch(() => {});
      this.process.kill("SIGKILL");
      await this.process.status;
    }
    await this.done;
    this.rmPortsFile();
    this.rmConfigFile();
    if (cleanup) {
      this.rmDataDir();
    }
  }

  signal(signal: string): Promise<void> {
    if (signal === "SIGKILL") {
      return this.stop();
    } else {
      //@ts-ignore: this is correct
      this.process.kill(signal);
      return Promise.resolve();
    }
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

  async connz(cid?: number, subs: boolean | "detail" = true): Promise<ConnZ> {
    if (!this.monitoring) {
      return Promise.reject(new Error("server is not monitoring"));
    }
    const args = [];
    args.push(`subs=${subs}`);
    if (cid) {
      args.push(`cid=${cid}`);
    }

    const qs = args.length ? args.join("&") : "";
    const resp = await fetch(`http://127.0.0.1:${this.monitoring}/connz?${qs}`);
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
    for (let i = 0; i < servers.length; i++) {
      servers[i].rmDataDir();
    }
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
    // form a cluster with the specified count
    const servers = await NatsServer.cluster(count, serverConf, debug);
    servers.forEach((s) => {
      s.updatePorts();
    });

    // extract all the configs
    const configs = servers.map((s) => {
      const { port, cluster, monitoring, websocket, config } = s;
      return { port, cluster, monitoring, websocket, config };
    });

    // stop all the servers and wait
    const proms = servers.map((s) => {
      return s.stop();
    });
    await Promise.all(proms);

    servers.forEach((s) => {
      s.debug = debug;
    });

    const routes: string[] = [];
    configs.forEach((conf) => {
      let { cluster, config } = conf;

      // jetstream defaults
      const { jetstream } = jsopts();
      if (js) {
        if (js.max_file_store !== undefined) {
          jetstream.max_file_store = js.max_file_store;
        }
        if (js.max_mem_store !== undefined) {
          jetstream.max_mem_store = js.max_mem_store;
        }
      }
      // need a server name for a cluster
      const serverName = nuid.next();

      config = extend(
        config,
        { jetstream },
        { server_name: serverName },
      );

      // set the specific ports that we ran on before
      config.cluster.listen = config.cluster.listen.replace("-1", `${cluster}`);
      routes.push(`nats://${config.cluster.listen}`);
    });

    // update the routes to be explicit
    configs.forEach((c) => {
      c.config.cluster.routes = routes.filter((v) => {
        return v.indexOf(c.config.cluster.listen) === -1;
      });
    });
    // reconfigure the servers
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
        // await for all the servers to resolve and get /jsz
        servers = await Promise.all(proms);
        servers.forEach((s) => {
          statusProms.push(s.jsz());
        });

        // await for all the jsz to resolve
        const status = await Promise.all(statusProms);
        status.forEach((i) => {
          const leader = i.meta_cluster.leader;
          if (leader) {
            leaders.push(leader);
          }
        });
        // if we resolved leaders on all
        if (leaders.length === proms.length) {
          // unique them
          const u = leaders.filter((v, idx, a) => {
            return a.indexOf(v) === idx;
          });
          // if we have one, we fine
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

    const fn = async function (s: NatsServer) {
      const dp = deferred<void>();
      const to = timeout<void>(5000);
      let done = false;
      to.catch((err) => {
        done = true;
        dp.reject(
          new Error(
            `${s.hostname}:${s.port} failed to resolve peers: ${err.toString}`,
          ),
        );
      });

      while (!done) {
        const data = await s.varz();
        if (data) {
          const urls = data.connect_urls as string[];
          const others = urls.map((s) => {
            return parseHostport(s)?.port;
          });

          if (others.every((v) => ports.includes(v!))) {
            dp.resolve();
            to.cancel();
            break;
          }
        }
        await timeout(100);
      }
      return dp;
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
    conf = JSON.parse(JSON.stringify(conf || {}));
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
    conf.server_tags = Array.isArray(conf.server_targs)
        ? conf.server_tags.push(`id:${nuid.next()}`)
        : [`id:${nuid.next()}`];

    return conf;
  }

  /**
   * this is only expecting authentication type changes
   * @param conf
   */
  async reload(conf?: any): Promise<void> {
    conf = NatsServer.confDefaults(conf);
    conf.host = this.config.host;
    conf.port = this.config.port;
    conf.http = this.config.http;
    conf.leafnodes = this.config.leafnodes;
    conf = Object.assign(this.config, conf);
    await Deno.writeFile(
      this.configFile,
      new TextEncoder().encode(toConf(conf)),
    );
    return this.signal("SIGHUP");
  }

  static async tlsConfig(): Promise<
    {
      tls: { cert_file: string; key_file: string; ca_file: string };
      certsDir: string;
    }
  > {
    const certsDir = await Deno.makeTempDir({ prefix: "certs" });
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

  static async start(conf?: any, debug = false): Promise<NatsServer> {
    // const exe = Deno.env.get("CI") ? "nats-server/nats-server" : "nats-server";
    const exe =  "nats-server";
    const tmp = resolve(Deno.env.get("TMPDIR") || ".");
    conf = NatsServer.confDefaults(conf);
    conf.ports_file_dir = tmp;

    const confFile = Deno.makeTempFileSync({
      prefix: "nats-server_",
      suffix: ".conf",
    });
    Deno.writeFileSync(confFile, new TextEncoder().encode(toConf(conf)));
    if (debug) {
      console.info(`${exe} -c ${confFile}`);
    }
    const cmd = new Deno.Command(exe, {
      args: ["-c", confFile],
      stderr: "piped",
      stdout: "null",
      stdin: "null",
    });

    const srv = cmd.spawn();
    if (srv.pid) {
      if (debug) {
        console.info(`config: ${confFile}`);
        console.info(`[${srv.pid}] - launched`);
      }
    }

    const portsFile = resolve(
      join(tmp, `nats-server_${srv.pid}.ports`),
    );

    const pi = await check(
      () => {
        try {
          const data = Deno.readFileSync(portsFile);
          const txt = new TextDecoder().decode(data);
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
        async () => {
          try {
            if (debug) {
              console.info(`[${srv.pid}] - attempting to connect`);
            }
            const conn = await Deno.connect(ports as Deno.ConnectOptions);
            conn.close();
            return ports.port;
          } catch (_) {
            // ignore
          }
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
      try {
        const { stderr: d } = await cmd.output();
        console.error(new TextDecoder().decode(d));
      } catch (err) {
        console.error("unable to read server output:", err);
      }
      throw err;
    }
  }
}

// @ts-ignore: any is exactly what we need here
export function toConf(o: any, indent?: string): string {
  const pad = indent !== undefined ? indent + "  " : "";
  const buf = [];
  for (const k in o) {
    if (Object.prototype.hasOwnProperty.call(o, k)) {
      //@ts-ignore: tsc,
      const v = o[k];
      if (Array.isArray(v)) {
        buf.push(`${pad}${k} [`);
        buf.push(toConf(v, pad));
        buf.push(`${pad} ]`);
      } else if (typeof v === "object") {
        // don't print a key if it is an array and it is an index
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
          if (v.includes(" ") || v.startsWith("$") || ((v.includes("{{") && v.includes("}")))) {
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
