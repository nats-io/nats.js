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

import {
  checkOptions,
  checkUnsupportedOption,
  DataBuffer,
  deferred,
  Empty,
  ErrorCode,
  extractProtocolMessage,
  INFO,
  NatsError,
  render,
} from "@nats-io/nats-core/internal";

import type {
  ConnectionOptions,
  Deferred,
  ServerInfo,
  TlsOptions,
  Transport,
} from "@nats-io/nats-core/internal";

import { writeAll } from "@std/io";
import { version } from "./version.ts";

const VERSION = version;
const LANG = "nats.deno";

const ReadBufferSize = 1024 * 256;

export class DenoTransport implements Transport {
  version: string = VERSION;
  lang: string = LANG;
  closeError?: Error;
  private options!: ConnectionOptions;
  private buf: Uint8Array;
  private encrypted = false;
  private done = false;
  private closedNotification: Deferred<void | Error> = deferred();
  private conn!: Deno.TcpConn | Deno.TlsConn;
  private frames: Array<Uint8Array>;
  private pendingWrite: Promise<void> | null;

  constructor() {
    this.buf = new Uint8Array(ReadBufferSize);
    this.frames = [];
    this.pendingWrite = null;
  }

  async connect(
    hp: { hostname: string; port: number; tlsName: string },
    options: ConnectionOptions,
  ) {
    this.options = options;

    const { tls } = this.options;
    const { handshakeFirst } = tls || {};

    try {
      if (handshakeFirst === true) {
        const opts = await this.loadTlsOptions(hp.hostname);
        const ctls = {
          caCerts: opts.caCerts,
          hostname: hp.hostname,
          port: hp.port,
        };
        this.conn = await Deno.connectTls(ctls);
        this.encrypted = true;
        // do nothing yet.
      } else {
        this.conn = await Deno.connect(hp);
      }
      if (this.done) {
        this.conn.close();
      }
      const info = await this.peekInfo();
      checkOptions(info, this.options);
      const { tls_required: tlsRequired, tls_available: tlsAvailable } = info;
      const desired = tlsAvailable === true && options.tls !== null;
      if (!handshakeFirst && (tlsRequired || desired)) {
        const tlsn = hp.tlsName ? hp.tlsName : hp.hostname;
        await this.startTLS(tlsn);
      }
      if (this.done) {
        this.conn.close();
      }
    } catch (err) {
      this.conn?.close();
      throw (err as NatsError)?.name === "ConnectionRefused"
        ? NatsError.errorForCode(ErrorCode.ConnectionRefused)
        : err;
    }
  }

  get isClosed(): boolean {
    return this.done;
  }

  async peekInfo(): Promise<ServerInfo> {
    const inbound = new DataBuffer();
    let pm: string;
    while (true) {
      const c = await this.conn.read(this.buf);
      if (c === null) {
        // EOF
        throw new Error("socket closed while expecting INFO");
      } else if (c) {
        const frame = this.buf.subarray(0, c);
        if (this.options.debug) {
          console.info(`> ${render(frame)}`);
        }
        inbound.fill(frame);
        const raw = inbound.peek();
        pm = extractProtocolMessage(raw);
        if (pm !== "") {
          break;
        }
      }
    }
    // reset the buffer to previously read, so the client
    // can validate the info matches the connection
    this.buf = new Uint8Array(inbound.drain());
    // expecting the info protocol
    const m = INFO.exec(pm);
    if (!m) {
      throw new Error("unexpected response from server");
    }
    return JSON.parse(m[1]) as ServerInfo;
  }

  async loadTlsOptions(hostname: string): Promise<Deno.StartTlsOptions> {
    const tls = this.options && this.options.tls
      ? this.options.tls
      : {} as TlsOptions;

    // these options are not available in Deno
    checkUnsupportedOption("tls.ca", tls.ca);
    checkUnsupportedOption("tls.cert", tls.cert);
    checkUnsupportedOption("tls.certFile", tls.certFile);
    checkUnsupportedOption("tls.key", tls.key);
    checkUnsupportedOption("tls.keyFile", tls.keyFile);

    const sto = { hostname } as Deno.StartTlsOptions;
    if (tls.caFile) {
      const ca = await Deno.readTextFile(tls.caFile);
      sto.caCerts = [ca];
    }
    return sto;
  }

  async startTLS(hostname: string): Promise<void> {
    const sto = await (this.loadTlsOptions(hostname));
    this.conn = await Deno.startTls(
      //@ts-ignore: just the conn
      this.conn as Deno.TcpConn,
      sto,
    );
    // this is necessary because the startTls process doesn't
    // reject a bad certificate, however the next write will.
    // to identify this as the error, we force it
    await this.conn.write(Empty);
    this.encrypted = true;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    let reason: Error | undefined;
    // yield what we initially read
    yield this.buf;

    while (!this.done) {
      try {
        this.buf = new Uint8Array(ReadBufferSize);
        const c = await this.conn.read(this.buf);
        if (c === null) {
          break;
        }
        if (c) {
          const frame = this.buf.subarray(0, c);
          if (this.options.debug) {
            console.info(`> ${render(frame)}`);
          }
          yield frame;
        }
      } catch (err) {
        reason = err as Error;
        break;
      }
    }
    this._closed(reason).then().catch();
  }

  maybeWriteFrame(): void {
    if (this.pendingWrite) {
      return;
    }

    const frame = this.frames.shift();
    if (!frame) {
      return;
    }
    this.pendingWrite = writeAll(this.conn, frame).then(() => {
      this.pendingWrite = null;
      this.maybeWriteFrame();
    }).then(() => {
      if (this.options.debug) {
        console.info(`< ${render(frame)}`);
      }
    }).catch((err) => {
      if (this.options.debug) {
        console.error(`!!! ${render(frame)}: ${err}`);
      }
    });
  }

  send(frame: Uint8Array): void {
    // if we are closed, don't do anything
    if (this.done) {
      return;
    }
    // push the frame
    this.frames.push(frame);
    this.maybeWriteFrame();
  }

  isEncrypted(): boolean {
    return this.encrypted;
  }

  close(err?: Error): Promise<void> {
    return this._closed(err, false);
  }

  disconnect() {
    this._closed(undefined, true)
      .then().catch();
  }

  async _closed(err?: Error, internal = true): Promise<void> {
    if (this.done) {
      // it is possible for close to be called before the connection
      // ever happens or after the protocol requested a close (async connection/upgrade)
      // so even if we already cleaned up, attempt to close the connection
      try {
        this.conn?.close();
      } catch (_err) {
        // ignored
      }
      return;
    }
    this.done = true;
    this.closeError = err;
    if (!err && internal) {
      try {
        // this is a noop but gives us a place to hang
        // a close and ensure that we sent all before closing
        // we wait for the operation to fail or succeed
        this.frames.push(Empty);
        this.maybeWriteFrame();
        if (this.pendingWrite) {
          await this.pendingWrite;
        }
      } catch (err) {
        if (this.options.debug) {
          console.log("transport close terminated with an error", err);
        }
      }
    }
    try {
      this.conn?.close();
    } catch (_err) {
      // ignored
    }

    if (internal) {
      this.closedNotification.resolve(err);
    }
  }

  closed(): Promise<void | Error> {
    return this.closedNotification;
  }

  discard() {
    // ignored - this is not required, as there's no throttling
  }
}

export async function denoResolveHost(s: string): Promise<string[]> {
  const a = Deno.resolveDns(s, "A");
  const aaaa = Deno.resolveDns(s, "AAAA");
  const ips: string[] = [];
  const w = await Promise.allSettled([a, aaaa]);
  if (w[0].status === "fulfilled") {
    ips.push(...w[0].value);
  }
  if (w[1].status === "fulfilled") {
    ips.push(...w[1].value);
  }
  if (ips.length === 0) {
    ips.push(s);
  }
  return ips;
}
