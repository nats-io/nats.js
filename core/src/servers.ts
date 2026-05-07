/*
 * Copyright 2018-2024 The NATS Authors
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
import { getUrlParseFn } from "./transport.ts";
import { shuffle } from "./util.ts";
import { isIP } from "./ipparser.ts";
import type {
  DnsResolveFn,
  Server,
  ServerInfo,
  ServersChanged,
} from "./core.ts";
import { DEFAULT_PORT } from "./core.ts";
import { InvalidArgumentError } from "./errors.ts";

export function isIPV4OrHostname(hp: string): boolean {
  // in the wild seeing IPv4s as IPv6s
  // ::ffff:35.234.43.228 which incorrectly get mapped to IPv4 unless
  // we add this test first
  if (hp.indexOf("[") !== -1 || hp.indexOf("::") !== -1) {
    return false;
  }
  if (hp.indexOf(".") !== -1) {
    return true;
  }
  // if we have a plain hostname or host:port
  if (hp.split(":").length <= 2) {
    return true;
  }
  return false;
}

function isIPV6(hp: string) {
  return !isIPV4OrHostname(hp);
}

function filterIpv6MappedToIpv4(hp: string): string {
  const prefix = "::FFFF:";
  const idx = hp.toUpperCase().indexOf(prefix);
  if (idx !== -1 && hp.indexOf(".") !== -1) {
    // we have something like: ::FFFF:127.0.0.1 or [::FFFF:127.0.0.1]:4222
    let ip = hp.substring(idx + prefix.length);
    ip = ip.replace("[", "");
    return ip.replace("]", "");
  }

  return hp;
}

export function hostPort(
  u: string,
): { listen: string; hostname: string; port: number } {
  u = u.trim();
  // remove any protocol that may have been provided
  if (u.match(/^(.*:\/\/)(.*)/m)) {
    u = u.replace(/^(.*:\/\/)(.*)/gm, "$2");
  }
  // in web environments, URL may not be a living standard
  // that means that protocols other than HTTP/S are not
  // parsable correctly.

  // the third complication is that we may have been given
  // an IPv6 or worse IPv6 mapping an Ipv4
  u = filterIpv6MappedToIpv4(u);

  // we only wrap cases where they gave us a plain ipv6
  // and we are not already bracketed
  if (isIPV6(u) && u.indexOf("[") === -1) {
    u = `[${u}]`;
  }
  // if we have ipv6, we expect port after ']:' otherwise after ':'
  const op = isIPV6(u) ? u.match(/(]:)(\d+)/) : u.match(/(:)(\d+)/);
  const port = op && op.length === 3 && op[1] && op[2]
    ? parseInt(op[2])
    : DEFAULT_PORT;

  // the next complication is that new URL() may
  // eat ports which match the protocol - so for example
  // port 80 may be eliminated - so we flip the protocol
  // so that it always yields a value
  const protocol = port === 80 ? "https" : "http";
  const url = new URL(`${protocol}://${u}`);
  url.port = `${port}`;

  let hostname = url.hostname;
  // if we are bracketed, we need to rip it out
  if (hostname.charAt(0) === "[") {
    hostname = hostname.substring(1, hostname.length - 1);
  }
  const listen = url.host;

  return { listen, hostname, port };
}

/**
 * @hidden
 */
export class ServerImpl implements Server {
  src: string;
  listen: string;
  hostname: string;
  port: number;
  didConnect: boolean;
  reconnects: number;
  lastConnect: number;
  gossiped: boolean;
  tlsName: string;
  resolves?: Server[];

  constructor(u: string, gossiped = false) {
    this.src = u;
    this.tlsName = "";
    const v = hostPort(u);
    this.listen = v.listen;
    this.hostname = v.hostname;
    this.port = v.port;
    this.didConnect = false;
    this.reconnects = 0;
    this.lastConnect = 0;
    this.gossiped = gossiped;
  }

  toString(): string {
    return this.listen;
  }

  async resolve(
    opts: Partial<
      {
        fn: DnsResolveFn;
        randomize: boolean;
        resolve: boolean;
        debug: boolean;
      }
    >,
  ): Promise<Server[]> {
    if (!opts.fn || opts.resolve === false) {
      // we cannot resolve - transport doesn't support it
      // or user opted out
      // don't add - to resolves or we get a circ reference
      return [this];
    }

    const buf: Server[] = [];
    if (isIP(this.hostname)) {
      // don't add - to resolves or we get a circ reference
      return [this];
    } else {
      // resolve the hostname to ips
      const ips = await opts.fn(this.hostname);
      if (opts.debug) {
        console.log(`resolve ${this.hostname} = ${ips.join(",")}`);
      }

      for (const ip of ips) {
        // letting URL handle the details of representing IPV6 ip with a port, etc
        // careful to make sure the protocol doesn't line with standard ports or they
        // get swallowed
        const proto = this.port === 80 ? "https" : "http";
        // ipv6 won't be bracketed here, because it came from resolve
        const url = new URL(`${proto}://${isIPV6(ip) ? "[" + ip + "]" : ip}`);
        url.port = `${this.port}`;
        const ss = new ServerImpl(url.host, false);
        ss.tlsName = this.hostname;
        buf.push(ss);
      }
    }
    if (opts.randomize) {
      shuffle(buf);
    }
    this.resolves = buf;
    return buf;
  }
}

/**
 * @hidden
 */
export class Servers {
  private firstSelect: boolean;
  private servers: ServerImpl[];
  private currentServer!: ServerImpl;
  private tlsName: string;
  private randomize: boolean;

  constructor(opts: Partial<{ randomize: boolean }> = {}) {
    this.firstSelect = true;
    this.servers = [];
    this.tlsName = "";
    this.randomize = opts.randomize || false;
  }

  /**
   * Replace the server pool with the provided list of `host:port` entries.
   *
   * Throws `InvalidArgumentError` if `listens` is empty or not an array.
   *
   * Note: reconnect attempts continue to follow the configured reconnect
   * policy, but if every entry in the new pool is unreachable the
   * connection may be left unable to recover.
   */
  setServers(listens: string[]): void {
    if (!Array.isArray(listens) || listens.length === 0) {
      throw InvalidArgumentError.format("servers", "cannot be empty");
    }
    const urlParseFn = getUrlParseFn();
    const existing = new Map<string, ServerImpl>();
    for (const s of this.servers) existing.set(s.listen, s);

    const merged: ServerImpl[] = [];
    for (let hp of listens) {
      hp = urlParseFn ? urlParseFn(hp) : hp;
      const { listen } = hostPort(hp);
      const surviving = existing.get(listen);
      if (surviving) {
        // user-supplied = not gossiped. otherwise a later cluster update()
        // could remove an entry the user explicitly asked for.
        surviving.gossiped = false;
        merged.push(surviving);
      } else {
        merged.push(new ServerImpl(hp));
      }
    }
    if (this.randomize) shuffle(merged);

    this.servers = merged;
    if (
      this.currentServer === undefined ||
      !merged.includes(this.currentServer)
    ) {
      this.currentServer = merged[0];
      this.firstSelect = true;
    }
  }

  clear(): void {
    this.servers.length = 0;
  }

  updateTLSName(): void {
    const cs = this.getCurrentServer();
    if (!isIP(cs.hostname)) {
      this.tlsName = cs.hostname;
      this.servers.forEach((s) => {
        if (s.gossiped) {
          s.tlsName = this.tlsName;
        }
      });
    }
  }

  getCurrentServer(): ServerImpl {
    return this.currentServer;
  }

  addServer(u: string, implicit = false): void {
    const urlParseFn = getUrlParseFn();
    u = urlParseFn ? urlParseFn(u) : u;
    const s = new ServerImpl(u, implicit);
    if (isIP(s.hostname)) {
      s.tlsName = this.tlsName;
    }
    this.servers.push(s);
  }

  selectServer(): ServerImpl | undefined {
    // allow using select without breaking the order of the servers
    if (this.firstSelect) {
      this.firstSelect = false;
      return this.currentServer;
    }
    const t = this.servers.shift();
    if (t) {
      this.servers.push(t);
      this.currentServer = t;
    }
    return t;
  }

  removeCurrentServer(): void {
    this.removeServer(this.currentServer);
  }

  removeServer(server: ServerImpl | undefined): void {
    if (server) {
      const index = this.servers.indexOf(server);
      this.servers.splice(index, 1);
    }
  }

  /**
   * Returns a frozen snapshot of the server pool in natural order.
   * Each entry is a defensive copy — callers cannot mutate pool state.
   */
  snapshot(): ReadonlyArray<Server> {
    return Servers.freezeAll(this.servers);
  }

  /**
   * Returns a frozen snapshot of the server pool with the current server
   * (= next dial candidate) at index 0. Used to present the handler with
   * the server the library would have selected.
   */
  snapshotForHandler(): ReadonlyArray<Server> {
    const cur = this.currentServer;
    if (!cur) return this.snapshot();
    const idx = this.servers.indexOf(cur);
    if (idx <= 0) return this.snapshot();
    return Servers.freezeAll(
      [cur, ...this.servers.slice(0, idx), ...this.servers.slice(idx + 1)],
    );
  }

  private static freezeAll(arr: ServerImpl[]): ReadonlyArray<Server> {
    return arr.map((s) =>
      Object.freeze<Server>({
        hostname: s.hostname,
        port: s.port,
        listen: s.listen,
        src: s.src,
        tlsName: s.tlsName,
        reconnects: s.reconnects,
        lastConnect: s.lastConnect,
        gossiped: s.gossiped,
        didConnect: s.didConnect,
      })
    );
  }

  find(server: Server): ServerImpl | undefined {
    return this.servers.find((s) => s.listen === server.listen);
  }

  setCurrent(server: ServerImpl): void {
    this.currentServer = server;
  }

  length(): number {
    return this.servers.length;
  }

  next(): ServerImpl | undefined {
    return this.servers.length ? this.servers[0] : undefined;
  }

  getServers(): ServerImpl[] {
    return this.servers;
  }

  update(info: ServerInfo, encrypted?: boolean): ServersChanged {
    const added: string[] = [];
    let deleted: string[] = [];

    const urlParseFn = getUrlParseFn();
    const discovered = new Map<string, ServerImpl>();
    if (info.connect_urls && info.connect_urls.length > 0) {
      info.connect_urls.forEach((hp) => {
        hp = urlParseFn ? urlParseFn(hp, encrypted) : hp;
        const s = new ServerImpl(hp, true);
        discovered.set(hp, s);
      });
    }
    // remove gossiped servers that are no longer reported
    const toDelete: number[] = [];
    this.servers.forEach((s, index) => {
      const u = s.listen;
      if (
        s.gossiped && this.currentServer.listen !== u &&
        discovered.get(u) === undefined
      ) {
        // server was removed
        toDelete.push(index);
      }
      // remove this entry from reported
      discovered.delete(u);
    });

    // perform the deletion
    toDelete.reverse();
    toDelete.forEach((index) => {
      const removed = this.servers.splice(index, 1);
      deleted = deleted.concat(removed[0].listen);
    });

    // remaining servers are new
    discovered.forEach((v, k) => {
      this.servers.push(v);
      added.push(k);
    });

    // shuffle the pool so reconnect picks distribute across the cluster.
    // currentServer is held at the head — the live connection isn't
    // disturbed, but rotation order through the rest is randomized.
    if (this.randomize && added.length > 0) {
      const cur = this.currentServer;
      const others = this.servers.filter((s) => s !== cur);
      shuffle(others);
      this.servers = cur ? [cur, ...others] : others;
    }

    return { added, deleted };
  }
}
