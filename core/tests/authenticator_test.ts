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

import { cleanup, setup } from "test_helpers";

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
} from "../src/internal_mod.ts";

import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  encodeAccount,
  encodeOperator,
  encodeUser,
  fmtCreds,
} from "jsr:@nats-io/jwt@0.0.11";
import { assertBetween } from "test_helpers";

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
  const authenticator = (nonce?: string): Auth => {
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
