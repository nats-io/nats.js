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
import { TD } from "./encoders.ts";

import type {
  ConnectionOptions,
  DnsResolveFn,
  Server,
  URLParseFn,
} from "./core.ts";

import { DEFAULT_PORT } from "./core.ts";
import { DataBuffer } from "./databuffer.ts";

let transportConfig: TransportFactory;
export function setTransportFactory(config: TransportFactory): void {
  transportConfig = config;
}

export function getTransportFactory(): TransportFactory {
  return transportConfig;
}

export function defaultPort(): number {
  return transportConfig !== undefined &&
      transportConfig.defaultPort !== undefined
    ? transportConfig.defaultPort
    : DEFAULT_PORT;
}

export function getUrlParseFn(): URLParseFn | undefined {
  return transportConfig !== undefined && transportConfig.urlParseFn
    ? transportConfig.urlParseFn
    : undefined;
}

export function newTransport(): Transport {
  if (!transportConfig || typeof transportConfig.factory !== "function") {
    throw new Error("transport fn is not set");
  }
  return transportConfig.factory();
}

export function getResolveFn(): DnsResolveFn | undefined {
  return transportConfig !== undefined && transportConfig.dnsResolveFn
    ? transportConfig.dnsResolveFn
    : undefined;
}

export interface TransportFactory {
  factory?: () => Transport;
  defaultPort?: number;
  urlParseFn?: URLParseFn;
  dnsResolveFn?: DnsResolveFn;
}

export interface Transport extends AsyncIterable<Uint8Array> {
  readonly isClosed: boolean;
  readonly lang: string;
  readonly version: string;
  readonly closeError?: Error;
  // set when the connection is stale (the server stopped responding).
  // closing a stale transport doesn't flush pending data, as it may never drain
  stale?: boolean;

  connect(
    server: Server,
    opts: ConnectionOptions,
  ): Promise<void>;

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array>;

  isEncrypted(): boolean;

  send(frame: Uint8Array): void;

  close(err?: Error): Promise<void>;

  disconnect(): void;

  closed(): Promise<void | Error>;

  // this is here for websocket implementations as some implementations
  // (firefox) throttle connections that then resolve later
  discard(): void;
}

export const CR_LF = "\r\n";
export const CR_LF_LEN = CR_LF.length;
export const CRLF = DataBuffer.fromAscii(CR_LF);
export const CR = new Uint8Array(CRLF)[0]; // 13
export const LF = new Uint8Array(CRLF)[1]; // 10
export function protoLen(ba: Uint8Array): number {
  for (let i = 0; i < ba.length; i++) {
    const n = i + 1;
    if (ba.byteLength > n && ba[i] === CR && ba[n] === LF) {
      return n + 1;
    }
  }
  return 0;
}

export function extractProtocolMessage(a: Uint8Array): string {
  // protocol messages are ascii, so Uint8Array
  const len = protoLen(a);
  if (len > 0) {
    const ba = new Uint8Array(a);
    const out = ba.slice(0, len);
    return TD.decode(out);
  }
  return "";
}
