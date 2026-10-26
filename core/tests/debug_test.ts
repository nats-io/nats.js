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
import { connect } from "./connect.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import {
  createInbox,
  debugFrame,
  render,
  wsconnect,
} from "../src/internal_mod.ts";
import type {
  ConnectionOptions,
  DebugFn,
  NatsConnection,
  NatsConnectionImpl,
} from "../src/internal_mod.ts";
import { NatsServer, wsServerConf } from "nst";

type Connector = (
  ns: NatsServer,
  opts: ConnectionOptions,
) => Promise<NatsConnection>;

const transports: [string, () => Record<string, unknown>, Connector][] = [
  ["deno", () => ({}), (ns, opts) => connect({ port: ns.port, ...opts })],
  [
    "ws",
    () => wsServerConf(),
    (ns, opts) =>
      wsconnect({ servers: `ws://127.0.0.1:${ns.websocket}`, ...opts }),
  ],
];

// runs fn with console.info/console.error captured
async function captureConsole(
  fn: () => Promise<void>,
): Promise<{ info: string[]; error: unknown[][] }> {
  const { info, error } = console;
  const out = { info: [] as string[], error: [] as unknown[][] };
  console.info = (...args: unknown[]) => {
    out.info.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    out.error.push(args);
  };
  try {
    await fn();
  } finally {
    console.info = info;
    console.error = error;
  }
  return out;
}

// a request to an echo service makes frames in both directions
async function roundTrip(nc: NatsConnection): Promise<void> {
  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_, m) => {
      m.respond(m.data);
    },
  });
  const r = await nc.request(subj, "hello");
  assertEquals(r.string(), "hello");
}

for (const [name, conf, connectTo] of transports) {
  Deno.test(`debug - ${name} - true prints frames`, async () => {
    const ns = await NatsServer.start(conf());
    const { info } = await captureConsole(async () => {
      const nc = await connectTo(ns, { debug: true });
      await roundTrip(nc);
      await nc.close();
    });
    await ns.stop();
    assert(info.some((l) => l.startsWith("> INFO ")));
    assert(info.some((l) => l.startsWith("< CONNECT ")));
    assert(info.every((l) => l.startsWith("> ") || l.startsWith("< ")));
  });

  Deno.test(`debug - ${name} - function gets frames both ways`, async () => {
    const ns = await NatsServer.start(conf());
    const frames: [string, string][] = [];
    const { info } = await captureConsole(async () => {
      const nc = await connectTo(ns, {
        debug: (d, f) => {
          frames.push([d, render(f)]);
        },
      });
      await roundTrip(nc);
      await nc.close();
    });
    await ns.stop();
    assertEquals(info, []);
    assert(frames.some(([d, f]) => d === ">" && f.startsWith("INFO ")));
    assert(frames.some(([d, f]) => d === "<" && f.startsWith("CONNECT ")));
    assert(frames.some(([d, f]) => d === "<" && f.includes("hello")));
    assert(frames.some(([d, f]) => d === ">" && f.includes("hello")));
  });

  Deno.test(`debug - ${name} - function can't change frames`, async () => {
    const ns = await NatsServer.start(conf());
    // zero every frame the hook gets - the connection must not notice
    const nc = await connectTo(ns, {
      debug: (_, f) => {
        f.fill(0);
      },
    });
    await roundTrip(nc);
    await nc.close();
    await ns.stop();
  });

  Deno.test(`debug - ${name} - throwing function is turned off`, async () => {
    const ns = await NatsServer.start(conf());
    let calls = 0;
    const boom = new Error("boom");
    const debug: DebugFn = () => {
      calls++;
      throw boom;
    };
    const opts = { debug } as ConnectionOptions;
    const { error } = await captureConsole(async () => {
      const nc = await connectTo(ns, opts);
      await roundTrip(nc);
      await nc.close();
    });
    await ns.stop();
    assertEquals(calls, 1);
    assertEquals(error.length, 1);
    const err = error[0][0] as Error;
    assertStringIncludes(err.message, "debug function threw");
    assertEquals(err.cause, boom);
    // the caller's options are untouched
    assertEquals(opts.debug, debug);
  });

  Deno.test(`debug - ${name} - function set and removed while running`, async () => {
    const ns = await NatsServer.start(conf());
    const nc = await connectTo(ns, {}) as NatsConnectionImpl;
    const frames: string[] = [];
    await roundTrip(nc);
    assertEquals(frames, []);

    nc.options.debug = (_, f) => {
      frames.push(render(f));
    };
    await roundTrip(nc);
    const n = frames.length;
    assert(n > 0);
    assert(frames.some((f) => f.includes("hello")));

    nc.options.debug = false;
    await roundTrip(nc);
    assertEquals(frames.length, n);
    await nc.close();
    await ns.stop();
  });
}

Deno.test("debug - frame helper", async () => {
  const frame = new TextEncoder().encode("PING\r\n");
  const err = new Error("write failed");

  // false and unset do nothing
  const { info, error } = await captureConsole(() => {
    debugFrame({}, "<", frame);
    debugFrame({ debug: false }, "<", frame);
    debugFrame({ debug: true }, "<", frame);
    debugFrame({ debug: true }, "<", frame, err);
    return Promise.resolve();
  });
  assertEquals(info, ["< PING␍␊"]);
  assertEquals(error.length, 1);
  assertEquals(error[0].join(" "), "!!! PING␍␊: Error: write failed");

  // a function gets a copy and the error
  let got: [string, Uint8Array, Error | undefined] | undefined;
  debugFrame(
    {
      debug: (d, f, e) => {
        got = [d, f, e];
      },
    },
    "<",
    frame,
    err,
  );
  assertExists(got);
  assertEquals(got[0], "<");
  assertEquals(got[1], frame);
  assertFalse(got[1] === frame);
  assertEquals(got[2], err);

  // a non-Error is wrapped
  debugFrame(
    {
      debug: (d, f, e) => {
        got = [d, f, e];
      },
    },
    "<",
    frame,
    "boom",
  );
  assert(got[2] instanceof Error);
  assertEquals(got[2].message, "boom");
});
