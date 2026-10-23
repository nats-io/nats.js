/*
 * Copyright 2018-2023 The NATS Authors
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
  defaultOptions,
  deferred,
  Empty,
  extractProtocolMessage,
  MuxSubscription,
  ProtocolHandler,
  protoLen,
  RequestOne,
  setTransportFactory,
  SubscriptionImpl,
  Subscriptions,
} from "../src/internal_mod.ts";
import type { Msg, Publisher, Transport } from "../src/internal_mod.ts";
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  equal,
} from "@std/assert";
import { errors } from "../src/errors.ts";

Deno.test("protocol - mux subscription cancel", async () => {
  const mux = new MuxSubscription();
  mux.init();

  const r = new RequestOne(mux, "");
  r.token = "alberto";
  mux.add(r);
  assertEquals(mux.size(), 1);
  assertEquals(mux.get("alberto"), r);
  assertEquals(mux.getToken({ subject: "" } as Msg), null);

  const check = assertRejects(
    () => {
      return Promise.race([r.deferred, r.timer]);
    },
    errors.RequestError,
    "cancelled",
  );

  r.cancel();

  await check;
  assertEquals(mux.size(), 0);
});

Deno.test("protocol - bad dispatch is noop", () => {
  const mux = new MuxSubscription();
  mux.init();
  mux.dispatcher()(null, { subject: "foo" } as Msg);
});

Deno.test("protocol - subs all", () => {
  const subs = new Subscriptions();

  const s = new SubscriptionImpl({
    unsubscribe(_s: SubscriptionImpl, _max?: number) {},
  } as ProtocolHandler, "hello");
  subs.add(s);
  assertEquals(subs.size(), 1);
  assertEquals(s.sid, 1);
  assertEquals(subs.sidCounter, 1);
  equal(subs.get(0), s);
  const a = subs.all();
  assertEquals(a.length, 1);
  subs.cancel(a[0]);
  assertEquals(subs.size(), 0);
});

Deno.test("protocol - cancel unknown sub", () => {
  const subs = new Subscriptions();
  const s = new SubscriptionImpl({
    unsubscribe(_s: SubscriptionImpl, _max?: number) {},
  } as ProtocolHandler, "hello");
  assertEquals(subs.size(), 0);
  subs.add(s);
  assertEquals(subs.size(), 1);
  subs.cancel(s);
  assertEquals(subs.size(), 0);
});

Deno.test("protocol - protolen -1 on empty", () => {
  assertEquals(protoLen(Empty), 0);
  assertEquals(extractProtocolMessage(Empty), "");
});

Deno.test("protocol - dial rejects a transport closed after handshake", async () => {
  const transportClosed = deferred<void | Error>();
  let isClosed = false;
  const frame = new TextEncoder().encode(
    'INFO {"server_id":"test","version":"2.12.0","proto":1,"host":"127.0.0.1","port":4222,"max_payload":1048576}\r\nPONG\r\n',
  );
  const transport: Transport = {
    get isClosed(): boolean {
      return isClosed;
    },
    lang: "test",
    version: "test",
    async connect(): Promise<void> {},
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
      yield frame;
      isClosed = true;
      transportClosed.resolve();
    },
    isEncrypted: () => false,
    send: () => {},
    close(): Promise<void> {
      isClosed = true;
      transportClosed.resolve();
      return Promise.resolve();
    },
    disconnect: () => {},
    closed: () => transportClosed,
    discard: () => {},
  };
  setTransportFactory({
    defaultPort: 4222,
    urlParseFn: (url) => url,
    factory: () => transport,
  });

  const protocol = new ProtocolHandler(
    { ...defaultOptions(), servers: ["127.0.0.1:4222"], timeout: 100 },
    { publish: () => {} } as Publisher,
  );
  const server = protocol.servers.selectServer();
  assert(server);
  protocol.server = server;

  let dialError: unknown;
  try {
    await protocol.dial(server);
  } catch (err) {
    dialError = err;
  } finally {
    await protocol.close();
  }

  assert(
    dialError instanceof errors.ConnectionError,
    `expected a connection error, got ${String(dialError)}`,
  );
  assertFalse(protocol.connected);
});
