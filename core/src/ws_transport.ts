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

import type {
  ConnectionOptions,
  NatsConnection,
  Server,
  ServerInfo,
} from "./core.ts";
import type { Deferred, Delay } from "./util.ts";
import { debugFrame, deferred, delay } from "./util.ts";
import type { Transport, TransportFactory } from "./transport.ts";
import { extractProtocolMessage, setTransportFactory } from "./transport.ts";
import { checkOptions } from "./options.ts";
import { DataBuffer } from "./databuffer.ts";
import { INFO } from "./protocol.ts";
import { NatsConnectionImpl } from "./nats.ts";
import { version } from "./version.ts";
import { errors, InvalidArgumentError } from "./errors.ts";
import { applyWssOnly } from "./servers.ts";

const VERSION = version;
const LANG = "nats.ws";

/**
 * WsSocketFactory is a factory that returns a WebSocket. Client code is
 * responsible for creating a W3C WebSocket compliant transport. Whether the
 * connection is encrypted is taken from the socket's `url`.
 *
 * @param u the url to connect to
 * @param opts the connection options
 * @returns a promise that resolves to a WebSocket
 */
export type WsSocketFactory = (u: string, opts: ConnectionOptions) => Promise<{
  socket: WebSocket;
}>;

/**
 * WsConnectionOptions exposes wsconnect specific options not applicable to
 * other transports.
 */
export interface WsConnectionOptions extends ConnectionOptions {
  wsFactory?: WsSocketFactory;
  /**
   * `true`: every server is wss. `null`: every server is ws. Unset: the
   * protocol in each server's URL (a plain `host:port` is wss).
   */
  wssOnly?: boolean | null;
}

export class WsTransport implements Transport {
  version: string;
  lang: string;
  closeError?: Error;
  stale?: boolean;
  connected: boolean;
  private done: boolean;
  // @ts-ignore: expecting global WebSocket
  private socket: WebSocket;
  private options!: WsConnectionOptions;
  socketClosed: boolean;
  // the wait between checks while close() drains the socket
  drainWait?: Delay;
  peeked: boolean;

  yields: Uint8Array[];
  signal: Deferred<void>;
  closedNotification: Deferred<void | Error>;

  constructor() {
    this.version = VERSION;
    this.lang = LANG;
    this.connected = false;
    this.done = false;
    this.socketClosed = false;
    this.peeked = false;
    this.yields = [];
    this.signal = deferred();
    this.closedNotification = deferred();
  }

  async connect(
    server: Server,
    options: WsConnectionOptions,
  ): Promise<void> {
    const connected = false;
    const ok = deferred<void>();

    this.options = options;
    const u = server.src;
    if (options.wsFactory) {
      const { socket } = await options.wsFactory(server.src, options);
      this.socket = socket;
    } else {
      this.socket = new WebSocket(u);
    }
    const { wssOnly } = options;
    if (
      (wssOnly === true && !this.encrypted) ||
      (wssOnly === null && this.encrypted)
    ) {
      const err = new errors.ConnectionError(
        `'wssOnly' requires ${
          wssOnly ? "wss" : "ws"
        }: the socket's url is "${this.socket.url}"`,
      );
      this.done = true;
      this.closeError = err;
      try {
        this.socket.close();
      } catch (_) {
        // nothing
      }
      this._cleanup();
      throw err;
    }
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
      if (this.done) {
        this._closed(new Error("aborted"));
      }
      // we don't do anything here...
    };

    this.socket.onmessage = (me: MessageEvent) => {
      if (this.done) {
        return;
      }
      this.yields.push(new Uint8Array(me.data));
      if (this.peeked) {
        this.signal.resolve();
        return;
      }
      const t = DataBuffer.concat(...this.yields);
      const pm = extractProtocolMessage(t);
      if (pm !== "") {
        const m = INFO.exec(pm);
        if (!m) {
          const err = new Error("unexpected response from server");
          debugFrame(options, ">", t, err);
          ok.reject(err);
          return;
        }
        try {
          const info = JSON.parse(m[1]) as ServerInfo;
          checkOptions(info, this.options);
          this.peeked = true;
          this.connected = true;
          this.signal.resolve();
          ok.resolve();
        } catch (err) {
          ok.reject(err);
          return;
        }
      }
    };

    // @ts-ignore: CloseEvent is provided in browsers
    this.socket.onclose = (evt: CloseEvent) => {
      let reason: Error | undefined;
      if (!evt.wasClean && evt.reason !== "") {
        reason = new Error(evt.reason);
      }
      this._closed(reason);
      this._cleanup();
    };

    // @ts-ignore: signature can be any
    this.socket.onerror = (e: ErrorEvent | Event): void => {
      if (this.done) {
        return;
      }
      const evt = e as ErrorEvent;
      const err = new errors.ConnectionError(evt.message);
      if (!connected) {
        ok.reject(err);
      } else {
        this._closed(err);
      }
      this._cleanup();
    };
    return ok;
  }

  _cleanup() {
    // a close that is still draining would otherwise leave its timer behind
    this.drainWait?.cancel();
    if (this.socketClosed === false) {
      // node seems to not emit closed if there's an error
      // all other runtimes do.
      this.socketClosed = true;
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.closedNotification.resolve(this.closeError);
    }
  }

  disconnect(): void {
    this._closed(undefined, true);
  }

  private async _closed(err?: Error, internal = true): Promise<void> {
    if (this.done) {
      try {
        this.socket.close();
      } catch (_) {
        // nothing
      }
      // an earlier close may still be waiting on a close event that a
      // stale connection never delivers
      if (this.stale) {
        this._cleanup();
      }
      return;
    }
    this.closeError = err;
    // a client close() flushes pending data, unless the connection failed.
    // a disconnect (stale, forced reconnect, errors) doesn't - callers that
    // care can flush first. a stale connection may never drain, so don't
    // wait on it
    if (!err && !internal && !this.stale) {
      while (
        !this.stale && !this.socketClosed && this.socket.bufferedAmount > 0
      ) {
        this.drainWait = delay(100);
        await this.drainWait;
      }
      this.drainWait = undefined;
    }
    this.done = true;
    try {
      this.socket.close();
    } catch (_) {
      // ignore this
    }
    // the close handshake can't complete on a stale connection, so the
    // close event may never come - don't wait for it
    if (this.stale) {
      this._cleanup();
    }

    return this.closedNotification as Promise<void>;
  }

  get isClosed(): boolean {
    return this.done;
  }

  [Symbol.asyncIterator]() {
    return this.iterate();
  }

  async *iterate(): AsyncIterableIterator<Uint8Array> {
    while (true) {
      if (this.done) {
        return;
      }
      if (this.yields.length === 0) {
        await this.signal;
      }
      const yields = this.yields;
      this.yields = [];
      for (let i = 0; i < yields.length; i++) {
        debugFrame(this.options, ">", yields[i]);
        yield yields[i];
      }
      // yielding could have paused and microtask
      // could have added messages. Prevent allocations
      // if possible
      if (this.done) {
        break;
      } else if (this.yields.length === 0) {
        yields.length = 0;
        this.yields = yields;
        this.signal = deferred();
      }
    }
  }

  // the socket's own url, also for a socket from a wsFactory
  get encrypted(): boolean {
    const u = this.socket?.url?.toLowerCase() ?? "";
    // a factory may produce an https:// (or http://) url, which the node ws
    // library dials as wss (or ws), so both tls spellings count as encrypted
    return u.startsWith("wss://") || u.startsWith("https://");
  }

  isEncrypted(): boolean {
    return this.connected && this.encrypted;
  }

  send(frame: Uint8Array): void {
    if (this.done) {
      return;
    }
    try {
      this.socket.send(frame.buffer);
      debugFrame(this.options, "<", frame);
      return;
    } catch (err) {
      // we ignore write errors because client will
      // fail on a read or when the heartbeat timer
      // detects a stale connection
      debugFrame(this.options, "<", frame, err);
    }
  }

  close(err?: Error | undefined): Promise<void> {
    return this._closed(err, false);
  }

  closed(): Promise<void | Error> {
    return this.closedNotification;
  }

  // this is to allow a force discard on a connection
  // if the connection fails during the handshake protocol.
  // Firefox for example, will keep connections going,
  // so eventually if it succeeds, the client will have
  // an additional transport running. With this
  discard() {
    this.socket?.close();
  }
}

export function wsUrlParseFn(
  u: string,
  encrypted?: boolean,
  bareTls = true,
): string {
  const ut = /^(.*:\/\/)(.*)/;
  if (typeof encrypted === "boolean") {
    // a gossiped entry is a host:port, dialed with the protocol of the
    // connection that reported it, never a scheme of its own
    u = `${encrypted ? "wss" : "ws"}://${u.replace(/^[^:/?#]*:\/\//, "")}`;
  } else if (!ut.test(u)) {
    // no protocol: wss, or ws when wssOnly is null
    u = `${bareTls ? "https" : "http"}://${u}`;
  }
  let url = new URL(u);
  const srcProto = url.protocol.toLowerCase();
  if (srcProto === "ws:") {
    encrypted = false;
  }
  if (srcProto === "wss:") {
    encrypted = true;
  }
  if (srcProto !== "https:" && srcProto !== "http:") {
    // other schemes don't parse a host and port everywhere, so parse as
    // http(s). match the scheme's security, as for a bare host above, so
    // URL only drops a port that is the default of the scheme we dial:
    // wss://h:80 keeps 80, and wss://h:443 falls back to 443 below
    const secure = srcProto === "wss:" || srcProto === "tls:" ||
      (srcProto !== "ws:" && srcProto !== "nats:" && encrypted === true);
    u = u.replace(/^(.*:\/\/)(.*)/gm, "$2");
    url = new URL(`${secure ? "https" : "http"}://${u}`);
  }

  let protocol;
  let port;
  const host = url.hostname;
  const path = url.pathname;
  const search = url.search || "";

  switch (srcProto) {
    case "http:":
    case "ws:":
    case "nats:":
      port = url.port || "80";
      protocol = "ws:";
      break;
    case "https:":
    case "wss:":
    case "tls:":
      port = url.port || "443";
      protocol = "wss:";
      break;
    default:
      port = url.port || (encrypted === true ? "443" : "80");
      protocol = encrypted === true ? "wss:" : "ws:";
      break;
  }
  return `${protocol}//${host}:${port}${path}${search}`;
}

export function wsconnect(
  opts: ConnectionOptions | WsConnectionOptions = {},
): Promise<NatsConnection> {
  if (opts.tls) {
    return Promise.reject(InvalidArgumentError.format(
      "tls",
      "is not configurable on w3c websocket connections",
    ));
  }
  // only exactly true, false or null: a truthy string or number would
  // otherwise be taken as unset
  const w = (opts as WsConnectionOptions).wssOnly;
  if (w !== undefined && w !== null && typeof w !== "boolean") {
    return Promise.reject(InvalidArgumentError.format(
      "wssOnly",
      "must be true, false or null",
    ));
  }
  const { wssOnly } = opts as WsConnectionOptions;
  // under wssOnly null a plain host:port (the default server and the port
  // option included) is ws
  const ws = wssOnly === null;
  const urlParseFn = ws
    ? (u: string, encrypted?: boolean) => wsUrlParseFn(u, encrypted, false)
    : wsUrlParseFn;
  setTransportFactory({
    defaultPort: ws ? 80 : 443,
    urlParseFn,
    factory: (): Transport => {
      return new WsTransport();
    },
  } as TransportFactory);
  if (opts.servers) {
    try {
      applyWssOnly(
        Array.isArray(opts.servers) ? opts.servers : [opts.servers],
        wssOnly,
        urlParseFn,
      );
    } catch (err) {
      return Promise.reject(err);
    }
  }
  return NatsConnectionImpl.connect(opts);
}
