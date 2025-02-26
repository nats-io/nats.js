/*
 * Copyright 2020-2021 The NATS Authors
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

export class Connection {
  conn: Deno.Conn | null;
  buf = new Uint8Array(1024 * 8);
  debug: boolean;
  pending: Promise<unknown>[] = [];
  ca?: ConnectionAction;

  static td = new TextDecoder();
  static ping = new TextEncoder().encode("PING\r\n");
  static pong = new TextEncoder().encode("PONG\r\n");

  constructor(conn: Deno.Conn, debug: boolean = false, ca?: ConnectionAction) {
    this.conn = conn;
    this.debug = debug;
    this.ca = ca;
  }

  async startReading() {
    if (this.conn) {
      while (true) {
        try {
          const c = await this.conn.read(this.buf);
          if (c === null) {
            break;
          }
          if (c) {
            const frame = this.buf.subarray(0, c);
            if (this.debug) {
              console.info("> cs (raw)", new TextDecoder().decode(frame));
            }
            this.processInbound(frame);
          }
        } catch (_err) {
          break;
        }
      }
      return this.close();
    }
  }

  processInbound(buf: Uint8Array): void {
    const td = new TextDecoder();
    const r = td.decode(buf);
    const lines = r.split("\r\n");
    lines.forEach((line) => {
      if (line === "") {
        return;
      }
      if (/^CONNECT\s+/.test(line)) {
        this.write(Connection.ping);
      } else if (/^PING/.test(line)) {
        this.write(Connection.pong);
        if (this.ca) {
          this.ca(this);
        }
      } else if (/^SUB\s+/i.test(line)) {
        // ignored
      } else if (/^PUB\s+/i.test(line)) {
        // ignored
      } else if (/^UNSUB\s+/i.test(line)) {
        // ignored
      } else if (/^MSG\s+/i.test(line)) {
        // ignored
      } else if (/^INFO\s+/i.test(line)) {
        // ignored
      }
    });
  }

  write(buf: Uint8Array) {
    try {
      if (this.conn) {
        if (this.debug) {
          console.log("< cs", new TextDecoder().decode(buf));
        }
        const p = this.conn.write(buf);
        p.finally(() => {
          this.pending.shift();
        });
        this.pending.push(p);
      }
    } catch (err) {
      console.trace("error writing", err);
    }
  }

  close(): Promise<void> {
    if (!this.conn) {
      return Promise.resolve();
    }
    const d = deferred<void>();
    const conn = this.conn;
    this.conn = null;

    Promise.all(this.pending)
      .finally(() => {
        conn.close();
        d.resolve();
      });

    return d;
  }
}

export interface ConnectionAction {
  (c: Connection): void;
}

export class TestServer {
  listener?: Deno.Listener;
  port: number;
  info: Uint8Array;
  debug: boolean;
  clients: Connection[] = [];
  accept: Deferred<void>;

  constructor(debug: boolean = false, ca?: ConnectionAction) {
    const listener = Deno.listen({ port: 0, transport: "tcp" });
    const { port } = listener.addr as Deno.NetAddr;
    this.port = port;
    this.debug = debug;
    this.listener = listener;
    this.info = new TextEncoder().encode(
      "INFO " + JSON.stringify({
        server_id: "TEST",
        version: "0.0.0",
        host: "127.0.0.1",
        port: port,
        auth_required: false,
      }) + "\r\n",
    );

    this.accept = deferred<void>();
    (async function (ts: TestServer) {
      for await (const socket of listener) {
        try {
          const c = new Connection(socket, debug, ca);
          ts.clients.push(c);
          c.write(ts.info);
          c.startReading();
        } catch (_err) {
          ts.accept.resolve();
          return;
        }
      }
    })(this);
  }

  getPort(): number {
    return this.port;
  }

  stop() {
    if (this.listener) {
      this.listener.close();
      const promises: Promise<unknown>[] = [];
      promises.push(this.accept);
      this.clients.forEach((c) => {
        promises.push(c.close());
      });
      Promise.all(promises)
        .finally(() => {
          this.listener?.close();
          this.listener = undefined;
        });
    } else {
      return Promise.resolve();
    }
  }
}
