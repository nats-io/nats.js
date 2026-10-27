/*
 * Copyright 2022-2024 The NATS Authors
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

import { cleanup, NatsServer, setup } from "nst";

import {
  credsAuthenticator,
  deadline,
  deferred,
  delay,
  jwtAuthenticator,
  nkeyAuthenticator,
  nkeys,
  tokenAuthenticator,
  usernamePasswordAuthenticator,
} from "../src/internal_mod.ts";
import type {
  Auth,
  Authenticator,
  NatsConnection,
  NatsConnectionImpl,
  Status,
} from "../src/internal_mod.ts";
import { errors } from "../src/internal_mod.ts";

import { multiAuthenticator } from "../src/authenticator.ts";
import { connect } from "./connect.ts";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  encodeAccount,
  encodeOperator,
  encodeUser,
  fmtCreds,
} from "@nats-io/jwt";
import { assertBetween } from "nst";

function disconnectReconnect(nc: NatsConnection): Promise<void> {
  const done = deferred<void>();
  const disconnect = deferred();
  const reconnect = deferred();
  (async () => {
    for await (const s of nc.status()) {
      switch (s.type) {
        case "disconnect":
          disconnect.resolve();
          break;
        case "reconnect":
          reconnect.resolve();
          break;
      }
    }
  })().then();

  Promise.all([disconnect, reconnect])
    .then(() => done.resolve()).catch((err) => done.reject(err));
  return done;
}

async function testAuthenticatorFn(
  fn: Authenticator,
  conf: Record<string, unknown>,
  debug = false,
): Promise<void> {
  let called = 0;
  const authenticator = (nonce?: string): Auth | Promise<Auth> => {
    called++;
    return fn(nonce);
  };
  conf = Object.assign({}, conf, { debug });
  const { ns, nc } = await setup(conf, {
    authenticator,
  });

  const cycle = disconnectReconnect(nc);

  await delay(2000);
  called = 0;
  const nci = nc as NatsConnectionImpl;
  nci.reconnect();
  await delay(1000);
  await deadline(cycle, 4000);
  assertBetween(called, 1, 10);
  await nc.flush();
  assertEquals(nc.isClosed(), false);
  await cleanup(ns, nc);
}

Deno.test("authenticator - username password fns", async () => {
  const user = "a";
  const pass = "a";
  const authenticator = usernamePasswordAuthenticator(() => {
    return user;
  }, () => {
    return pass;
  });

  await testAuthenticatorFn(authenticator, {
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
    },
  });
});

Deno.test("authenticator - username string password fn", async () => {
  const pass = "a";
  const authenticator = usernamePasswordAuthenticator("a", () => {
    return pass;
  });

  await testAuthenticatorFn(authenticator, {
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
    },
  });
});

Deno.test("authenticator - username fn password string", async () => {
  const user = "a";
  const authenticator = usernamePasswordAuthenticator(() => {
    return user;
  }, "a");

  await testAuthenticatorFn(authenticator, {
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
    },
  });
});

Deno.test("authenticator - token fn", async () => {
  const token = "tok";
  const authenticator = tokenAuthenticator(() => {
    return token;
  });

  await testAuthenticatorFn(authenticator, {
    authorization: {
      token,
    },
  });
});

Deno.test("authenticator - nkey fn", async () => {
  const user = nkeys.createUser();
  const seed = user.getSeed();
  const nkey = user.getPublicKey();

  const authenticator = nkeyAuthenticator(() => {
    return seed;
  });
  await testAuthenticatorFn(authenticator, {
    authorization: {
      users: [
        { nkey },
      ],
    },
  });
});

Deno.test("authenticator - jwt bearer fn", async () => {
  const O = nkeys.createOperator();
  const A = nkeys.createAccount();
  const U = nkeys.createUser();
  const ujwt = await encodeUser("U", U, A, { bearer_token: true });

  const authenticator = jwtAuthenticator(() => {
    return ujwt;
  });

  const resolver: Record<string, string> = {};
  resolver[A.getPublicKey()] = await encodeAccount("A", A, {
    limits: {
      conn: -1,
      subs: -1,
    },
  }, { signer: O });
  const conf = {
    operator: await encodeOperator("O", O),
    resolver: "MEMORY",
    "resolver_preload": resolver,
  };

  await testAuthenticatorFn(authenticator, conf);
});

Deno.test("authenticator - jwt fn", async () => {
  const O = nkeys.createOperator();
  const A = nkeys.createAccount();
  const U = nkeys.createUser();
  const ujwt = await encodeUser("U", U, A, {});

  const authenticator = jwtAuthenticator(() => {
    return ujwt;
  }, () => {
    return U.getSeed();
  });

  const resolver: Record<string, string> = {};
  resolver[A.getPublicKey()] = await encodeAccount("A", A, {
    limits: {
      conn: -1,
      subs: -1,
    },
  }, { signer: O });
  const conf = {
    operator: await encodeOperator("O", O),
    resolver: "MEMORY",
    "resolver_preload": resolver,
  };

  await testAuthenticatorFn(authenticator, conf);
});

Deno.test("authenticator - creds fn", async () => {
  const O = nkeys.createOperator();
  const A = nkeys.createAccount();
  const U = nkeys.createUser();
  const ujwt = await encodeUser("U", U, A, {});
  const creds = fmtCreds(ujwt, U);

  const authenticator = credsAuthenticator(() => {
    return creds;
  });

  const resolver: Record<string, string> = {};
  resolver[A.getPublicKey()] = await encodeAccount("A", A, {
    limits: {
      conn: -1,
      subs: -1,
    },
  }, { signer: O });
  const conf = {
    operator: await encodeOperator("O", O),
    resolver: "MEMORY",
    "resolver_preload": resolver,
  };

  await testAuthenticatorFn(authenticator, conf);
});

Deno.test("authenticator - bad creds", () => {
  assertThrows(
    () => {
      credsAuthenticator(new TextEncoder().encode("hello"))();
    },
    Error,
    "unable to parse credentials",
  );
});

// wraps an authenticator so it resolves after a delay
function asyncAuthenticator(fn: Authenticator, ms = 100): Authenticator {
  return async (nonce?: string): Promise<Auth> => {
    await delay(ms);
    return fn(nonce);
  };
}

Deno.test("authenticator - async username password", async () => {
  await testAuthenticatorFn(
    asyncAuthenticator(usernamePasswordAuthenticator("a", "a")),
    {
      authorization: {
        users: [{
          user: "a",
          password: "a",
        }],
      },
    },
  );
});

Deno.test("authenticator - async nkey signs the nonce", async () => {
  const kp = nkeys.createUser();
  const seed = kp.getSeed();

  await testAuthenticatorFn(
    asyncAuthenticator(nkeyAuthenticator(seed)),
    {
      authorization: {
        users: [{
          nkey: kp.getPublicKey(),
        }],
      },
    },
  );
});

Deno.test("authenticator - multi only async if one is", async () => {
  const sync = multiAuthenticator([
    usernamePasswordAuthenticator("a", "x"),
    tokenAuthenticator("t"),
  ]);
  assertEquals(sync(), { user: "a", pass: "x", auth_token: "t" });

  const mixed = multiAuthenticator([
    usernamePasswordAuthenticator("a", "x"),
    asyncAuthenticator(tokenAuthenticator("t")),
  ]);
  const p = mixed();
  assert(p instanceof Promise);
  assertEquals(await p, { user: "a", pass: "x", auth_token: "t" });
});

Deno.test("authenticator - sync and async in an array", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
    },
  }, {
    authenticator: [
      usernamePasswordAuthenticator("a", "bad"),
      // later authenticators override earlier ones
      asyncAuthenticator(() => ({ pass: "a" } as Auth)),
    ],
  });
  await nc.flush();
  await cleanup(ns, nc);
});

Deno.test("authenticator - async rejection closes", async () => {
  const ns = await NatsServer.start({
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
    },
  });
  await assertRejects(
    () =>
      connect({
        port: ns.port,
        reconnect: false,
        authenticator: () => Promise.reject(new Error("no creds for you")),
      }),
    Error,
    "no creds for you",
  );
  await ns.stop();
});

Deno.test("authenticator - close while async is pending sends no connect", async () => {
  let calls = 0;
  const pending = deferred<Auth>();
  const called = deferred();
  const frames: string[] = [];
  let signal: AbortSignal | undefined;
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
    },
  }, {
    authenticator: (nonce?: string, s?: AbortSignal) => {
      calls++;
      if (calls === 1) {
        return usernamePasswordAuthenticator("a", "a")(nonce);
      }
      signal = s;
      called.resolve();
      return pending;
    },
  });
  const nci = nc as NatsConnectionImpl;
  nci.reconnect();
  await called;
  // record what is handed to the transport from here on
  const t = nci.protocol.transport;
  const send = t.send.bind(t);
  t.send = (f: Uint8Array) => {
    frames.push(new TextDecoder().decode(f));
    send(f);
  };
  await nc.close();
  assertEquals(signal?.aborted, true);
  pending.resolve({ user: "a", pass: "a" });
  await delay(250);
  assertEquals(
    frames.filter((f) => f.startsWith("CONNECT")),
    [],
  );
  await ns.stop();
});

Deno.test("authenticator - pending when the server times out auth", async () => {
  let calls = 0;
  const late = deferred<Auth>();
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
      timeout: 0.5,
    },
  }, {
    // first connect is sync, reconnects wait on late, which resolves at the
    // end so cleanup isn't left with a pending authenticator
    authenticator: (nonce?: string) => {
      calls++;
      if (calls === 1) {
        return usernamePasswordAuthenticator("a", "a")(nonce);
      }
      return late;
    },
  });

  const statuses: Status[] = [];
  const done = (async () => {
    for await (const s of nc.status()) {
      if (s.type === "authenticatorPending" || s.type === "error") {
        statuses.push(s);
        if (s.type === "error") {
          break;
        }
      }
    }
  })();
  (nc as NatsConnectionImpl).reconnect();
  await deadline(done, 5000);

  assertEquals(statuses.length, 2);
  const [pending, error] = statuses;
  assert(pending.type === "authenticatorPending");
  assertBetween(pending.pending, 300, 1500);
  assertEquals(pending.server, nc.getServer());
  assert(error.type === "error");
  assertInstanceOf(error.error, errors.AuthorizationError);
  late.resolve({ user: "a", pass: "a" });
  await cleanup(ns, nc);
});

Deno.test("authenticator - no pending status if the authenticator resolved", async () => {
  let calls = 0;
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
    },
  }, {
    // async on connect, then bad credentials on the reconnect
    authenticator: (nonce?: string) => {
      calls++;
      return calls === 1
        ? asyncAuthenticator(usernamePasswordAuthenticator("a", "a"))(nonce)
        : usernamePasswordAuthenticator("a", "bad")(nonce);
    },
  });

  const statuses: Status[] = [];
  const done = (async () => {
    for await (const s of nc.status()) {
      if (s.type === "authenticatorPending" || s.type === "error") {
        statuses.push(s);
        if (s.type === "error") {
          break;
        }
      }
    }
  })();
  (nc as NatsConnectionImpl).reconnect();
  await deadline(done, 5000);

  assertEquals(statuses.length, 1);
  assert(statuses[0].type === "error");
  assertInstanceOf(statuses[0].error, errors.AuthorizationError);
  await cleanup(ns, nc);
});

Deno.test("authenticator - multi throw doesn't orphan an async authenticator", async () => {
  const fn = multiAuthenticator([
    () => Promise.reject(new Error("async failed")),
    () => {
      throw new Error("sync failed");
    },
  ]);
  assertThrows(() => fn(), Error, "sync failed");
  // an unhandled rejection would fail the test
  await delay(50);
});

Deno.test("authenticator - abandoned attempt aborts the signal", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
      timeout: 0.5,
    },
  }, {
    // the second call never resolves, the server times it out and the
    // client reconnects with the third
    authenticator: (nonce?: string, s?: AbortSignal) => {
      calls++;
      if (calls === 2) {
        signal = s;
        return new Promise<Auth>(() => {});
      }
      return usernamePasswordAuthenticator("a", "a")(nonce);
    },
  });

  const reconnected = (async () => {
    for await (const s of nc.status()) {
      if (s.type === "reconnect") {
        break;
      }
    }
  })();
  (nc as NatsConnectionImpl).reconnect();
  await deadline(reconnected, 5000);
  assertEquals(calls, 3);
  assertEquals(signal?.aborted, true);
  await cleanup(ns, nc);
});

Deno.test("authenticator - sync throw aborts a started async authenticator", async () => {
  const ns = await NatsServer.start();
  let signal: AbortSignal | undefined;
  await assertRejects(
    () =>
      connect({
        port: ns.port,
        reconnect: false,
        authenticator: [
          (_nonce?: string, s?: AbortSignal) => {
            signal = s;
            return new Promise<Auth>(() => {});
          },
          () => {
            throw new Error("sync failed");
          },
        ],
      }),
    Error,
    "sync failed",
  );
  assertEquals(signal?.aborted, true);
  await ns.stop();
});
