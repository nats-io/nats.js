/*
 * Copyright 2026 The NATS Authors
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
  getTransportFactory,
  ProtocolHandler,
  QueuedIteratorImpl,
  Servers,
  setTransportFactory,
} from "../src/internal_mod.ts";
import type {
  ConnectionOptions,
  Publisher,
  Status,
  Transport,
} from "../src/internal_mod.ts";
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { errors } from "../src/errors.ts";

const te = new TextEncoder();

const goodInfo = {
  server_id: "test",
  version: "2.12.0",
  proto: 1,
  host: "127.0.0.1",
  port: 4222,
  max_payload: 1048576,
};

function info(v: Record<string, unknown> | string): Uint8Array {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return te.encode(`INFO ${s}\r\n`);
}

const handshake = te.encode(
  `${new TextDecoder().decode(info(goodInfo))}PONG\r\n`,
);

// the bad infos, with what the error must mention
const badInfos: { name: string; info: string; mentions: string }[] = [
  {
    name: "malformed json",
    info: "{not json",
    mentions: "invalid server info",
  },
  {
    name: "connect_urls not an array",
    info: JSON.stringify({ ...goodInfo, connect_urls: "host:4222" }),
    mentions: 'connect_urls is not an array: "host:4222"',
  },
  {
    name: "unparseable connect_urls entry",
    info: JSON.stringify({ ...goodInfo, connect_urls: ["a b:4222"] }),
    mentions: 'invalid connect_urls entry "a b:4222"',
  },
  {
    name: "bad version",
    info: JSON.stringify({ ...goodInfo, version: "garbage" }),
    mentions: "'garbage' is not a semver value",
  },
];

type FakeTransport = Transport & {
  // sends frames to the client
  feed: (frame: Uint8Array) => void;
  disconnects: number;
};

// a transport that yields the frames it is fed, and stays open until closed
function fakeTransport(first: Uint8Array): FakeTransport {
  const transportClosed = deferred<void | Error>();
  const frames: Uint8Array[] = [first];
  let wake = deferred<void>();
  let closeError: Error | undefined;
  let isClosed = false;
  const close = (err?: Error) => {
    if (!isClosed) {
      isClosed = true;
      closeError = err;
      transportClosed.resolve(err);
      wake.resolve();
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
    disconnects: 0,
    feed(frame: Uint8Array) {
      frames.push(frame);
      wake.resolve();
    },
    connect(): Promise<void> {
      return Promise.resolve();
    },
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
      while (!isClosed) {
        const f = frames.shift();
        if (f) {
          yield f;
          continue;
        }
        await wake;
        wake = deferred<void>();
      }
    },
    isEncrypted: () => false,
    send: () => {},
    close(err?: Error): Promise<void> {
      close(err);
      return Promise.resolve();
    },
    disconnect: () => {
      t.disconnects++;
      close();
    },
    closed: () => transportClosed,
    discard: () => {},
  };
  return t;
}

async function withTransports(
  transports: FakeTransport[],
  fn: (protocol: ProtocolHandler, statuses: Status[]) => Promise<void>,
  opts: Partial<ConnectionOptions> = {},
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
  });
  const protocol = new ProtocolHandler(
    {
      ...defaultOptions(),
      servers: ["127.0.0.1:4222"],
      timeout: 2000,
      reconnectDelayHandler: () => 10,
      ...opts,
    },
    { publish: () => {} } as Publisher,
  );
  const server = protocol.servers.selectServer();
  assert(server);
  protocol.server = server;

  const statuses: Status[] = [];
  const listener = new QueuedIteratorImpl<Status>();
  protocol.listeners.push(listener);
  (async () => {
    for await (const s of listener) {
      statuses.push(s);
    }
  })().then();

  try {
    await fn(protocol, statuses);
  } finally {
    await protocol.close();
    setTransportFactory(prev);
  }
}

function errorStatus(statuses: Status[]): Error | undefined {
  const s = statuses.find((s) => s.type === "error");
  return s?.type === "error" ? s.error : undefined;
}

for (const bad of badInfos) {
  Deno.test(`bad info - ${bad.name} fails the connect right away`, async () => {
    const t = fakeTransport(info(bad.info));
    await withTransports([t], async (p, statuses) => {
      const start = Date.now();
      const err = await assertRejects(
        () => deadline(p.dial(p.server), 1000),
        errors.ProtocolError,
      );
      // well before the 2s connect timeout
      assert(Date.now() - start < 500);
      assertStringIncludes(err.message, bad.mentions);
      assertFalse(p.connected);
      assert(t.isClosed);
      assertEquals(errorStatus(statuses), err);
    });
  });
}

for (const bad of badInfos.filter((b) => b.name !== "bad version")) {
  Deno.test(`bad info - ${bad.name} on a live connection reconnects`, async () => {
    const first = fakeTransport(handshake);
    const second = fakeTransport(handshake);
    await withTransports([first, second], async (p, statuses) => {
      await p.dial(p.server);
      assert(p.connected);
      const servers = p.servers.getServers().map((s) => s.listen);

      first.feed(info(bad.info));
      await deadline(
        (async () => {
          while (!statuses.find((s) => s.type === "reconnect")) {
            await new Promise((r) => setTimeout(r, 5));
          }
        })(),
        1000,
      );

      const err = errorStatus(statuses);
      assert(err instanceof errors.ProtocolError);
      assertStringIncludes(err.message, bad.mentions);
      assertEquals(first.disconnects, 1);
      const types = statuses.map((s) => s.type);
      assert(types.indexOf("error") < types.indexOf("disconnect"));
      assert(types.indexOf("disconnect") < types.indexOf("reconnect"));
      assert(p.connected);
      assertEquals(p.servers.getServers().map((s) => s.listen), servers);
    });
  });
}

Deno.test("bad info - on a live connection without reconnect closes", async () => {
  const t = fakeTransport(handshake);
  await withTransports([t], async (p) => {
    await p.dial(p.server);
    t.feed(info({ ...goodInfo, connect_urls: ["a b:4222"] }));
    const err = await deadline(p.closed, 1000);
    assert(err instanceof errors.ProtocolError);
    assertStringIncludes(err.message, 'invalid connect_urls entry "a b:4222"');
    assert(p.isClosed());
  }, { reconnect: false });
});

Deno.test("bad info - a good info still applies", async () => {
  const t = fakeTransport(handshake);
  await withTransports([t], async (p, statuses) => {
    await p.dial(p.server);
    t.feed(info({ ...goodInfo, connect_urls: ["127.0.0.2:4222"] }));
    await deadline(
      (async () => {
        while (!statuses.find((s) => s.type === "update")) {
          await new Promise((r) => setTimeout(r, 5));
        }
      })(),
      1000,
    );
    assert(p.connected);
    assertFalse(statuses.some((s) => s.type === "error"));
    assert(p.servers.getServers().some((s) => s.listen === "127.0.0.2:4222"));
  });
});

Deno.test("bad info - servers update leaves the pool alone on a bad entry", () => {
  const servers = new Servers();
  servers.setServers(["127.0.0.1:4222"]);
  servers.selectServer();
  servers.update({ connect_urls: ["127.0.0.2:4222"] } as never);
  const before = servers.getServers().map((s) => s.listen);

  assertThrows(
    () =>
      servers.update(
        { connect_urls: ["127.0.0.3:4222", "a b:4222", 7] } as never,
      ),
    Error,
    'invalid connect_urls entry "a b:4222"',
  );
  assertThrows(
    () => servers.update({ connect_urls: ["127.0.0.3:4222", 7] } as never),
    Error,
    "invalid connect_urls entry 7: not a string",
  );
  assertThrows(
    () => servers.update({ connect_urls: { a: 1 } } as never),
    Error,
    'connect_urls is not an array: {"a":1}',
  );
  assertEquals(servers.getServers().map((s) => s.listen), before);
});
