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
import type {
  ConnectionOptions,
  Transport,
  Deferred,
  Server,
} from "./nats-base-client.ts";
import {
  ErrorCode,
  NatsError,
  render,
  deferred,
  delay,
} from "./nats-base-client.ts";

const VERSION = "1.0.0-110";
const LANG = "nats.ws";

export class WsTransport implements Transport {
  version: string = VERSION;
  lang: string = LANG;
  closeError?: Error;
  connected = false;
  private done = false;
  // @ts-ignore
  private socket: WebSocket;
  private options!: ConnectionOptions;
  socketClosed = false;
  encrypted = false;

  yields: Uint8Array[] = [];
  signal: Deferred<void> = deferred<void>();
  private closedNotification: Deferred<void | Error> = deferred();

  constructor() {
  }

  async connect(
    server: Server,
    options: ConnectionOptions,
  ): Promise<void> {
    const connected = false;
    const connLock = deferred<void>();

    this.options = options;
    const u = server.src;
    this.encrypted = u.indexOf("wss://") === 0;
    this.socket = new WebSocket(u);
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
      this.connected = true;
      connLock.resolve();
    };

    this.socket.onmessage = (me: MessageEvent) => {
      this.yields.push(new Uint8Array(me.data));
      this.signal.resolve();
    };

    //@ts-ignore
    this.socket.onclose = (evt: CloseEvent) => {
      this.socketClosed = true;
      let reason: Error | undefined;
      if (this.done) return;
      if (!evt.wasClean) {
        reason = new Error(evt.reason);
      }
      this._closed(reason);
    };

    this.socket.onerror = (e: ErrorEvent | Event): any => {
      const evt = e as ErrorEvent;
      const err = new NatsError(evt.message, ErrorCode.UNKNOWN);
      if (!connected) {
        connLock.reject(err);
      } else {
        this._closed(err);
      }
    };
    return connLock;
  }

  disconnect(): void {
    this._closed(undefined, true);
  }

  private async _closed(err?: Error, internal: boolean = true): Promise<void> {
    if (!this.connected) return;
    if (this.done) return;
    this.closeError = err;
    if (!err) {
      while (!this.socketClosed && this.socket.bufferedAmount > 0) {
        console.log(this.socket.bufferedAmount);
        await delay(100);
      }
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

  send(frame: Uint8Array): Promise<void> {
    if (this.done) {
      return Promise.resolve();
    }
    try {
      this.socket.send(frame.buffer);
      if (this.options.debug) {
        console.info(`< ${render(frame)}`);
      }
      return Promise.resolve();
    } catch (err) {
      if (this.options.debug) {
        console.error(`!!! ${render(frame)}: ${err}`);
      }
      return Promise.reject(err);
    }
  }

  close(err?: Error | undefined): Promise<void> {
    return this._closed(err, false);
  }

  closed(): Promise<void | Error> {
    return this.closedNotification;
  }
}
