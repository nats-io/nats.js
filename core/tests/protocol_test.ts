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
  deadline,
  defaultOptions,
  deferred,
  delay,
  Empty,
  extractProtocolMessage,
  getTransportFactory,
  MuxSubscription,
  ProtocolHandler,
  protoLen,
  QueuedIteratorImpl,
  RequestOne,
  setTransportFactory,
  SubscriptionImpl,
  Subscriptions,
} from "../src/internal_mod.ts";
import type {
  ConnectionOptions,
  Msg,
  Publisher,
  Status,
  Transport,
  TransportFactory,
} from "../src/internal_mod.ts";
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

const handshake = new TextEncoder().encode(
  'INFO {"server_id":"test","version":"2.12.0","proto":1,"host":"127.0.0.1","port":4222,"max_payload":1048576}\r\nPONG\r\n',
);

type FakeTransport = Transport & {
  // resolves when the transport closes
  done: Promise<void>;
  dialed: boolean;
  // closes from the transport side
  kill: (err?: Error) => void;
};

// a transport that yields the handshake, then runs afterHandshake
// and the frames it returns, and stays open until closed
function fakeTransport(
  afterHandshake?: (t: FakeTransport) => Promise<Uint8Array[]> | void,
): FakeTransport {
  const transportClosed = deferred<void | Error>();
  let closeError: Error | undefined;
  let isClosed = false;
  const close = (err?: Error) => {
    if (!isClosed) {
      isClosed = true;
      closeError = err;
      transportClosed.resolve(err);
    }
  };
  const t: FakeTransport = {
    get isClosed(): boolean {
      return isClosed;
    },
    get closeError(): Error | undefined {
      return closeError;
    },
    lang: "test",
    version: "test",
    done: transportClosed.then(() => {}),
    dialed: false,
    kill: close,
    connect(): Promise<void> {
      t.dialed = true;
      return Promise.resolve();
    },
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
      yield handshake;
      const frames = await afterHandshake?.(t) || [];
      for (const f of frames) {
        yield f;
      }
      await transportClosed;
    },
    isEncrypted: () => false,
    send: () => {},
    close(err?: Error): Promise<void> {
      close(err);
      return Promise.resolve();
    },
    disconnect: () => {},
    closed: () => transportClosed,
    discard: () => {},
  };
  return t;
}

async function withTransports(
  transports: FakeTransport[],
  fn: (protocol: ProtocolHandler) => Promise<void>,
  opts: Partial<ConnectionOptions> = {},
  factory: Partial<TransportFactory> = {},
): Promise<void> {
  const prev = getTransportFactory();
  const queue = [...transports];
  setTransportFactory({
    defaultPort: 4222,
    urlParseFn: (url) => url,
    factory: () => {
      const t = queue.shift();
      assert(t, "no more transports");
      return t;
    },
    ...factory,
  });
  const protocol = new ProtocolHandler(
    {
      ...defaultOptions(),
      servers: ["127.0.0.1:4222"],
      timeout: 100,
      ...opts,
    },
    { publish: () => {} } as Publisher,
  );
  const server = protocol.servers.selectServer();
  assert(server);
  protocol.server = server;
  try {
    await fn(protocol);
  } finally {
    await protocol.close();
    setTransportFactory(prev);
  }
}

Deno.test("protocol - dial rejects a transport closed after handshake", async () => {
  const boom = new Error("boom");
  const dead = fakeTransport((t) => t.kill(boom));
  const ok = fakeTransport();
  await withTransports([dead, ok], async (protocol) => {
    // the close reason is preserved
    const err = await assertRejects(() => protocol.dial(protocol.server));
    assertEquals(err, boom);
    assertFalse(protocol.connected);

    // and the dial loop recovers on the next transport
    await protocol.dialLoop();
    assert(protocol.connected);
  }, { waitOnFirstConnect: true, reconnectDelayHandler: () => 10 });
});

Deno.test("protocol - close while the handshake completes rejects the dial", async () => {
  let protocol: ProtocolHandler | undefined;
  let closing: Promise<void> | undefined;
  const t = fakeTransport(() => {
    closing = protocol!.close();
  });
  await withTransports([t], async (p) => {
    protocol = p;
    // a status listener makes close() await before closing the transport
    const listener = new QueuedIteratorImpl<Status>();
    p.listeners.push(listener);
    (async () => {
      for await (const _ of listener) {
        // drain
      }
    })().then();

    await assertRejects(
      () => p.dial(p.server),
      errors.ClosedConnectionError,
    );
    await closing;
    assertFalse(p.connected);
    assert(p.isClosed());
    assertEquals(p.heartbeats.timer, undefined);
  });
});

Deno.test("protocol - a replaced transport doesn't feed the new parser", async () => {
  const release = deferred<void>();
  const stale = fakeTransport(async () => {
    await release;
    return [new TextEncoder().encode("-ERR 'stale'\r\n")];
  });
  const current = fakeTransport();
  await withTransports([stale, current], async (protocol) => {
    await protocol.dial(protocol.server);
    await protocol.dial(protocol.server);

    let parsed = 0;
    protocol.parser.parse = () => {
      parsed++;
    };
    release.resolve();
    await delay(10);
    assertEquals(parsed, 0);
    stale.kill();
  });
});

Deno.test("protocol - close while the handshake completes skips other addresses", async () => {
  let protocol: ProtocolHandler | undefined;
  let closing: Promise<void> | undefined;
  const first = fakeTransport(() => {
    closing = protocol!.close();
  });
  const second = fakeTransport();
  await withTransports(
    [first, second],
    async (p) => {
      protocol = p;
      const listener = new QueuedIteratorImpl<Status>();
      p.listeners.push(listener);
      (async () => {
        for await (const _ of listener) {
          // drain
        }
      })().then();

      await assertRejects(
        () => p._doDial(p.server),
        errors.ClosedConnectionError,
      );
      await closing;
      assert(first.dialed);
      assertFalse(second.dialed);
    },
    { servers: ["nats.test:4222"], noRandomize: true },
    { dnsResolveFn: () => Promise.resolve(["127.0.0.1", "127.0.0.2"]) },
  );
});

Deno.test("protocol - concurrent close settles if the transport close throws", async () => {
  const t = fakeTransport();
  const boom = new Error("boom");
  t.close = () => Promise.reject(boom);
  await withTransports([t], async (p) => {
    await p.dial(p.server);
    const first = p.close();
    const second = p.close();
    const err = await assertRejects(() => first);
    assertEquals(err, boom);
    await deadline(second, 1000);
    assert(p.isClosed());
  });
});

Deno.test("protocol - close gives up on a transport that doesn't drain", async () => {
  const t = fakeTransport();
  let closes = 0;
  // never finishes closing unless it is stale, like a flush to a server
  // that stopped reading
  t.close = (): Promise<void> => {
    closes++;
    if (t.stale) {
      t.kill();
      return Promise.resolve();
    }
    return new Promise(() => {});
  };
  await withTransports([t], async (p) => {
    await p.dial(p.server);
    const start = Date.now();
    await deadline(p.close(), 2000);
    const elapsed = Date.now() - start;
    assert(t.stale);
    assertEquals(closes, 2);
    assert(elapsed >= 200 && elapsed < 1000, `elapsed ${elapsed}`);
  }, { closeTimeout: 200 } as Partial<ConnectionOptions>);
});

Deno.test("protocol - close doesn't mark a closing transport stale", async () => {
  const t = fakeTransport();
  let closes = 0;
  const close = t.close.bind(t);
  t.close = (err?: Error): Promise<void> => {
    closes++;
    return close(err);
  };
  await withTransports([t], async (p) => {
    await p.dial(p.server);
    await p.close();
    assertFalse(t.stale);
    assertEquals(closes, 1);
  }, { timeout: 200 });
});
