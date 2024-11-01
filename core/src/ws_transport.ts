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
import type { Deferred } from "./util.ts";
import { deferred, delay, render } from "./util.ts";
import type { Transport, TransportFactory } from "./transport.ts";
import { extractProtocolMessage, setTransportFactory } from "./transport.ts";
import { checkOptions } from "./options.ts";
import { DataBuffer } from "./databuffer.ts";
import { INFO } from "./protocol.ts";
import { NatsConnectionImpl } from "./nats.ts";
import { version } from "./version.ts";
import { errors, InvalidArgumentError } from "./errors.ts";

const VERSION = version;
const LANG = "nats.ws";

export type WsSocketFactory = (u: string, opts: ConnectionOptions) => Promise<{
  socket: WebSocket;
  encrypted: boolean;
}>;
interface WsConnectionOptions extends ConnectionOptions {
  wsFactory?: WsSocketFactory;
}

export class WsTransport implements Transport {
  version: string;
  lang: string;
  closeError?: Error;
  connected: boolean;
  private done: boolean;
  // @ts-ignore: expecting global WebSocket
  private socket: WebSocket;
  private options!: WsConnectionOptions;
  socketClosed: boolean;
  encrypted: boolean;
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
    this.encrypted = false;
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
      const { socket, encrypted } = await options.wsFactory(
        server.src,
        options,
      );
      this.socket = socket;
      this.encrypted = encrypted;
    } else {
      this.encrypted = u.indexOf("wss://") === 0;
      this.socket = new WebSocket(u);
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
          if (options.debug) {
            console.error("!!!", render(t));
          }
          ok.reject(new Error("unexpected response from server"));
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
      this.socketClosed = true;
      let reason: Error | undefined;
      if (!evt.wasClean) {
        reason = new Error(evt.reason);
      }
      this._closed(reason);
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.closedNotification.resolve(this.closeError);
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
    };
    return ok;
  }

  disconnect(): void {
    this._closed(undefined, true);
  }

  private async _closed(err?: Error, _internal = true): Promise<void> {
    if (this.done) {
      try {
        this.socket.close();
      } catch (_) {
        // nothing
      }
      return;
    }
    this.closeError = err;
    if (!err) {
      while (!this.socketClosed && this.socket.bufferedAmount > 0) {
        await delay(100);
      }
    }
    this.done = true;
    try {
      this.socket.close();
    } catch (_) {
      // ignore this
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
        if (this.options.debug) {
          console.info(`> ${render(yields[i])}`);
        }
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

  isEncrypted(): boolean {
    return this.connected && this.encrypted;
  }

  send(frame: Uint8Array): void {
    if (this.done) {
      return;
    }
    try {
      this.socket.send(frame.buffer);
      if (this.options.debug) {
        console.info(`< ${render(frame)}`);
      }
      return;
    } catch (err) {
      // we ignore write errors because client will
      // fail on a read or when the heartbeat timer
      // detects a stale connection
      if (this.options.debug) {
        console.error(`!!! ${render(frame)}: ${err}`);
      }
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

export function wsUrlParseFn(u: string, encrypted?: boolean): string {
  const ut = /^(.*:\/\/)(.*)/;
  if (!ut.test(u)) {
    // if we have no hint to encrypted and no protocol, assume encrypted
    // else we fix the url from the update to match
    if (typeof encrypted === "boolean") {
      u = `${encrypted === true ? "https" : "http"}://${u}`;
    } else {
      u = `https://${u}`;
    }
  }
  let url = new URL(u);
  const srcProto = url.protocol.toLowerCase();
  if (srcProto === "ws:") {
    encrypted = false;
  }
  if (srcProto === "wss:") {
    encrypted = true;
  }
  if (srcProto !== "https:" && srcProto !== "http") {
    u = u.replace(/^(.*:\/\/)(.*)/gm, "$2");
    url = new URL(`http://${u}`);
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
      port = url.port || encrypted === true ? "443" : "80";
      protocol = encrypted === true ? "wss:" : "ws:";
      break;
  }
  return `${protocol}//${host}:${port}${path}${search}`;
}

export function wsconnect(
  opts: ConnectionOptions = {},
): Promise<NatsConnection> {
  setTransportFactory({
    defaultPort: 443,
    urlParseFn: wsUrlParseFn,
    factory: (): Transport => {
      if (opts.tls) {
        throw InvalidArgumentError.format(
          "tls",
          "is not configurable on w3c websocket connections",
        );
      }
      return new WsTransport();
    },
  } as TransportFactory);

  return NatsConnectionImpl.connect(opts);
}
