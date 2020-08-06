/*
 * Copyright 2020 The NATS Authors
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
import {
  ErrorCode,
  NatsError,
  render,
  Transport,
  Deferred,
  deferred,
} from "https://deno.land/x/nats@v0.1.1-19/nats-base-client/internal_mod.ts";

import { ConnectionOptions } from "./nats-base-client.ts";

const VERSION = "1.0.0-50";
const LANG = "nats.ws";

export class WsTransport implements Transport {
  version: string = VERSION;
  lang: string = LANG;
  closeError?: Error;
  private done = false;
  // @ts-ignore
  private socket: WebSocket;
  private options!: ConnectionOptions;

  yields: Uint8Array[] = [];
  signal: Deferred<void> = deferred<void>();
  private closedNotification: Deferred<void | Error> = deferred();

  private sendQueue: Array<{
    frame: Uint8Array;
    d: Deferred<void>;
  }> = [];

  constructor() {
  }

  async connect(
    hp: { hostname: string; port: number },
    options: ConnectionOptions,
  ): Promise<void> {
    const connected = false;
    const connLock = deferred<void>();

    this.options = options;
    const proto = this.options.ws ? "ws" : "wss";
    // @ts-ignore
    this.socket = new WebSocket(
      `${proto}://${hp.hostname}:${hp.port}`,
    );
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
      connLock.resolve();
    };

    this.socket.onmessage = (me: MessageEvent) => {
      this.yields.push(new Uint8Array(me.data));
      this.signal.resolve();
    };

    //@ts-ignore
    this.socket.onclose = (evt: CloseEvent) => {
      let reason: Error | undefined;
      if (this.done) return;
      if (!evt.wasClean) {
        reason = new Error(evt.reason);
      }
      this._closed(reason);
    };

    this.socket.onerror = (evt: ErrorEvent) => {
      const err = new NatsError(evt.message, ErrorCode.UNKNOWN);
      if (!connected) {
        connLock.reject(err);
      } else {
        this._closed(err);
      }
    };
    return connLock;
  }

  private enqueue(frame: Uint8Array): Promise<void> {
    if (this.done) {
      return Promise.resolve();
    }
    const d = deferred<void>();
    this.sendQueue.push({ frame, d });
    if (this.sendQueue.length === 1) {
      this.dequeue();
    }
    return d;
  }

  private dequeue(): void {
    const [entry] = this.sendQueue;
    if (!entry) return;
    if (this.done) return;
    const { frame, d } = entry;
    try {
      this.socket.send(frame.buffer);
      if (this.options.debug) {
        console.info(`< ${render(frame)}`);
      }
      d.resolve();
    } catch (err) {
      if (this.options.debug) {
        console.error(`!!! ${render(frame)}: ${err}`);
      }
      d.reject(err);
    } finally {
      this.sendQueue.shift();
      this.dequeue();
    }
  }

  disconnect(): void {
    this._closed(undefined, true);
  }

  private async _closed(err?: Error, internal: boolean = true): Promise<void> {
    if (this.done) return;
    this.closeError = err;
    if (!err) {
      await this.enqueue(new TextEncoder().encode("+OK\r\n"));
    }
    this.done = true;
    try {
      // 1002 endpoint error, 1000 is clean
      this.socket.close(err ? 1002 : 1000, err ? err.message : undefined);
    } catch (err) {
    }
    if (internal) {
      this.closedNotification.resolve(err);
    }
  }

  get isClosed(): boolean {
    return this.done;
  }

  [Symbol.asyncIterator]() {
    return this.iterate();
  }

  async *iterate(): AsyncIterableIterator<Uint8Array> {
    while (true) {
      await this.signal;
      while (this.yields.length > 0) {
        const frame = this.yields.shift();
        if (frame) {
          if (this.options.debug) {
            console.info(`> ${render(frame)}`);
          }
          yield frame;
        }
      }
      if (this.done) {
        break;
      } else {
        this.signal = deferred();
      }
    }
  }

  isEncrypted(): boolean {
    // ws from nats-server is only supported over tls
    return !this.options.ws;
  }

  send(frame: Uint8Array): Promise<void> {
    return this.enqueue(frame);
  }

  close(err?: Error | undefined): Promise<void> {
    return this._closed(err, false);
  }

  closed(): Promise<void | Error> {
    return this.closedNotification;
  }
}
