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
import { type Deferred, deferred } from "@nats-io/nats-core/internal";
import { createServer, type Server, type Socket } from "node:net";
import type { Buffer } from "node:buffer";

const td = new TextDecoder();

export type ConnectionAction = (c: Connection) => void;

export class Connection {
  socket: Socket | null;
  debug: boolean;
  pending: Promise<unknown>[] = [];
  ca?: ConnectionAction;
  closed: Deferred<void>;

  static ping: Uint8Array = new TextEncoder().encode("PING\r\n");
  static pong: Uint8Array = new TextEncoder().encode("PONG\r\n");

  constructor(socket: Socket, debug: boolean = false, ca?: ConnectionAction) {
    this.socket = socket;
    this.debug = debug;
    this.ca = ca;
    this.closed = deferred<void>();
  }

  startReading(): void {
    if (!this.socket) return;
    this.socket.on("data", (chunk: Buffer) => {
      if (this.debug) {
        console.info("> cs (raw)", chunk.toString());
      }
      this.processInbound(chunk);
    });
    this.socket.on("close", () => {
      this.closed.resolve();
    });
    this.socket.on("error", () => {
      this.closed.resolve();
    });
  }

  processInbound(buf: Uint8Array): void {
    const r = td.decode(buf);
    const lines = r.split("\r\n");
    lines.forEach((line) => {
      if (line === "") return;
      if (/^CONNECT\s+/.test(line)) {
        this.write(Connection.ping);
      } else if (/^PING/.test(line)) {
        this.write(Connection.pong);
        if (this.ca) {
          this.ca(this);
        }
      }
    });
  }

  write(buf: Uint8Array): void {
    try {
      if (this.socket && !this.socket.destroyed) {
        if (this.debug) {
          console.log("< cs", td.decode(buf));
        }
        const p = new Promise<void>((resolve, reject) => {
          this.socket!.write(buf, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        p.finally(() => {
          this.pending.shift();
        });
        this.pending.push(p);
      }
    } catch (err) {
      console.trace("error writing", err);
    }
  }

  async close(): Promise<void> {
    if (!this.socket) {
      return;
    }
    const sock = this.socket;
    this.socket = null;
    await Promise.allSettled(this.pending);
    sock.destroy();
    await this.closed;
  }
}

export class TestServer {
  listener?: Server;
  port: number;
  info: Uint8Array;
  debug: boolean;
  clients: Connection[] = [];
  accept: Deferred<void>;
  ready: Deferred<void>;

  constructor(debug: boolean = false, ca?: ConnectionAction) {
    this.debug = debug;
    this.port = 0;
    this.accept = deferred<void>();
    this.ready = deferred<void>();
    this.info = new TextEncoder().encode("");

    const server = createServer((socket) => {
      try {
        const c = new Connection(socket, debug, ca);
        this.clients.push(c);
        c.write(this.info);
        c.startReading();
      } catch (_err) {
        this.accept.resolve();
      }
    });
    server.on("close", () => {
      this.accept.resolve();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        this.port = addr.port;
        this.info = new TextEncoder().encode(
          "INFO " + JSON.stringify({
            server_id: "TEST",
            version: "0.0.0",
            host: "127.0.0.1",
            port: this.port,
            auth_required: false,
          }) + "\r\n",
        );
      }
      this.ready.resolve();
    });
    this.listener = server;
  }

  getPort(): number {
    return this.port;
  }

  async stop(): Promise<void> {
    if (!this.listener) return;
    const server = this.listener;
    this.listener = undefined;
    await Promise.allSettled(this.clients.map((c) => c.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.accept;
  }
}
