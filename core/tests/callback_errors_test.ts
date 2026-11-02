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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { connect } from "./connect.ts";
import { cleanup, NatsServer, setup } from "nst";
import { delay, Empty, errors } from "../src/internal_mod.ts";
import type {
  Msg,
  MsgCallback,
  UnhandledCallbackError,
} from "../src/internal_mod.ts";

// captures the callback errors printed with console.error, until restored
// or disposed, so a failing test doesn't leave it patched
function capturePrinted(): {
  errors: UnhandledCallbackError[];
  restore: () => void;
  [Symbol.dispose]: () => void;
} {
  const found: UnhandledCallbackError[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    const e = args[0];
    if (e instanceof errors.UnhandledCallbackError) {
      found.push(e);
    } else {
      orig(...args);
    }
  };
  const restore = () => {
    console.error = orig;
  };
  return { errors: found, restore, [Symbol.dispose]: restore };
}

// fails the test if anything is left unhandled
function captureUnhandled(): {
  reasons: unknown[];
  restore: () => void;
  [Symbol.dispose]: () => void;
} {
  const reasons: unknown[] = [];
  const onRejection = (e: PromiseRejectionEvent) => {
    reasons.push(e.reason);
    e.preventDefault();
  };
  const onError = (e: ErrorEvent) => {
    reasons.push(e.error);
    e.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  globalThis.addEventListener("error", onError);
  const restore = () => {
    globalThis.removeEventListener("unhandledrejection", onRejection);
    globalThis.removeEventListener("error", onError);
  };
  return { reasons, restore, [Symbol.dispose]: restore };
}

Deno.test("callback errors - a throwing subscription callback is printed and the connection continues", async () => {
  const { ns, nc } = await setup();
  using printed = capturePrinted();

  const boom = new Error("boom");
  const got: string[] = [];
  nc.subscribe("a", {
    callback: (_err, msg) => {
      got.push(msg.string());
      throw boom;
    },
  });
  let other = 0;
  nc.subscribe("b", {
    callback: () => {
      other++;
    },
  });
  await nc.flush();

  nc.publish("a", "1");
  nc.publish("b");
  nc.publish("a", "2");
  await nc.flush();
  printed.restore();

  // the subscription, other subscriptions and the connection keep working
  assertEquals(got, ["1", "2"]);
  assertEquals(other, 1);
  assertEquals(printed.errors.length, 2);
  assertEquals(
    printed.errors[0].message,
    'subscription callback for "a" threw Error: boom',
  );
  // the original error, so its stack leads to the callback
  assert(printed.errors[0].cause === boom);

  await cleanup(ns, nc);
});

Deno.test("callback errors - non-errors and rejections are printed as they are", async () => {
  const { ns, nc } = await setup();
  using printed = capturePrinted();
  using unhandled = captureUnhandled();

  nc.subscribe("undefined", {
    queue: "q",
    callback: () => {
      throw undefined;
    },
  });
  nc.subscribe("rejects", {
    callback: async (): Promise<never> => {
      await delay(0);
      throw "bad";
    },
  });
  await nc.flush();
  nc.publish("undefined");
  nc.publish("rejects");
  await nc.flush();
  await delay(20);
  printed.restore();
  unhandled.restore();

  assertEquals(printed.errors.map((e) => e.message), [
    'subscription callback for "undefined" (queue "q") threw undefined',
    'subscription callback for "rejects" threw "bad"',
  ]);
  assertEquals(printed.errors[0].cause, undefined);
  assertEquals(printed.errors[1].cause, "bad");
  assertEquals(unhandled.reasons, []);

  await cleanup(ns, nc);
});

Deno.test("callback errors - callbacks that don't fail print nothing", async () => {
  const { ns, nc } = await setup();
  using printed = capturePrinted();
  let n = 0;
  nc.subscribe("a", {
    callback: () => {
      n++;
    },
  });
  nc.subscribe("b", {
    // an async callback that resolves
    callback: (async () => {
      await delay(0);
      n++;
    }) as unknown as MsgCallback<Msg>,
  });
  await nc.flush();
  nc.publish("a");
  nc.publish("b");
  await nc.flush();
  await delay(20);
  printed.restore();
  assertEquals(n, 2);
  assertEquals(printed.errors, []);
  await cleanup(ns, nc);
});

Deno.test("callback errors - a callback failing on a permission violation still closes the subscription", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permissions: { subscribe: "foo" },
      }],
    },
  }, { user: "a", pass: "a", reconnect: false });
  using printed = capturePrinted();

  const got: Error[] = [];
  const sub = nc.subscribe("bar", {
    callback: (err) => {
      got.push(err!);
      throw undefined;
    },
  });
  await sub.closed;
  printed.restore();

  // the callback got the error, the subscription closed, and the connection
  // still works
  assertEquals(got.length, 1);
  assert(got[0] instanceof errors.PermissionViolationError);
  assertEquals(printed.errors.map((e) => e.message), [
    'subscription callback for "bar" threw undefined',
  ]);
  assertEquals(nc.isClosed(), false);
  await nc.flush();

  await cleanup(ns, nc);
});

Deno.test("callback errors - a callback failing on a subscription timeout is printed", async () => {
  const { ns, nc } = await setup();
  using printed = capturePrinted();
  using unhandled = captureUnhandled();

  const got: Error[] = [];
  nc.subscribe("a", {
    timeout: 100,
    callback: (err) => {
      got.push(err!);
      throw "bad";
    },
  });
  // a callback subscription's closed doesn't settle on a timeout
  await delay(200);
  printed.restore();
  unhandled.restore();

  assertEquals(got.length, 1);
  assert(got[0] instanceof errors.TimeoutError);
  assertEquals(printed.errors.map((e) => e.message), [
    'subscription callback for "a" threw "bad"',
  ]);
  assertEquals(unhandled.reasons, []);
  await nc.flush();

  await cleanup(ns, nc);
});

for (const noMux of [false, true]) {
  Deno.test(
    `callback errors - a failing request many strategy fails the request${
      noMux ? " noMux" : ""
    }`,
    async () => {
      const { ns, nc } = await setup();
      nc.subscribe("q", {
        callback: (_err, msg) => {
          msg.respond("1");
          msg.respond("2");
        },
      });

      const iter = await nc.requestMany("q", Empty, {
        maxWait: Infinity,
        noMux,
        strategy: () => {
          throw undefined;
        },
      });
      const got: string[] = [];
      const err = await assertRejects(async () => {
        for await (const m of iter) {
          got.push(m.string());
        }
      }, errors.UnhandledCallbackError);
      // the response the strategy failed on was delivered
      assertEquals(got, ["1"]);
      assertEquals(err.message, "request many strategy threw undefined");
      assertEquals(err.cause, undefined);
      await nc.flush();

      await cleanup(ns, nc);
    },
  );
}

Deno.test("callback errors - a failing reconnectDelayHandler closes the client with an error", async () => {
  let ns = await NatsServer.start();
  // it is also called for the first connect
  let connected = false;
  const nc = await connect({
    port: ns.port,
    maxReconnectAttempts: -1,
    reconnectDelayHandler: () => {
      if (!connected) {
        return 0;
      }
      throw undefined;
    },
  });
  connected = true;
  ns = await ns.restart();
  const err = await nc.closed();
  assert(err instanceof errors.UnhandledCallbackError);
  assertEquals(err.message, "reconnectDelayHandler threw undefined");
  await ns.stop();
});

Deno.test("callback errors - a failing waitOnFirstConnect rejects the connect with an error", async () => {
  const ns = await NatsServer.start();
  const port = ns.port;
  await ns.stop();
  const err = await assertRejects(
    () =>
      connect({
        port,
        waitOnFirstConnect: () => {
          throw null;
        },
      }),
    errors.UnhandledCallbackError,
  );
  assertEquals(err.message, "waitOnFirstConnect threw null");
});

Deno.test("callback errors - an authenticator failing with a non-error fails the connection with an error", async () => {
  const ns = await NatsServer.start();
  const sync = await assertRejects(
    () =>
      connect({
        port: ns.port,
        authenticator: () => {
          throw undefined;
        },
      }),
    errors.UnhandledCallbackError,
    "authenticator threw undefined",
  );
  assertEquals(sync.cause, undefined);

  const async = await assertRejects(
    () =>
      connect({
        port: ns.port,
        authenticator: () => Promise.reject(null),
      }),
    errors.UnhandledCallbackError,
    "authenticator threw null",
  );
  assertEquals(async.cause, null);

  // errors are as they were
  await assertRejects(
    () =>
      connect({
        port: ns.port,
        authenticator: () => {
          throw new Error("user code exploded");
        },
      }),
    Error,
    "user code exploded",
  );
  await ns.stop();
});
