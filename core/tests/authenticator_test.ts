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
  AuthorizationError,
  credsAuthenticator,
  deadline,
  deferred,
  delay,
  jwtAuthenticator,
  nkeyAuthenticator,
  nkeyFromWebCryptoPublicKey,
  nkeys,
  tokenAuthenticator,
  usernamePasswordAuthenticator,
  webCryptoJwtAuthenticator,
} from "../src/internal_mod.ts";
import type {
  Auth,
  Authenticator,
  NatsConnection,
  NatsConnectionImpl,
} from "../src/internal_mod.ts";

import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import type { Buffer } from "node:buffer";
import { connect } from "./connect.ts";
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

// Mirrors nkeyAuthenticator's own signing logic (authenticator.ts) rather
// than reusing it directly, wrapped with a real delay — proves this is a
// genuinely asynchronous authenticator settling later, not a Promise that
// happens to resolve synchronously on the same microtask.
function delayedNkeyAsyncAuthenticator(
  seed: Uint8Array,
  delayMs: number,
): (nonce?: string) => Promise<Auth> {
  return async (nonce?: string): Promise<Auth> => {
    await delay(delayMs);
    const kp = nkeys.fromSeed(seed);
    const nkey = kp.getPublicKey();
    const challenge = new TextEncoder().encode(nonce || "");
    const sig = nkeys.encode(kp.sign(challenge));
    return { nkey, sig };
  };
}

Deno.test("authenticator - async fn", async () => {
  const user = nkeys.createUser();
  const seed = user.getSeed();
  const nkey = user.getPublicKey();

  const { ns, nc } = await setup({
    authorization: {
      users: [{ nkey }],
    },
  }, {
    asyncAuthenticator: delayedNkeyAsyncAuthenticator(seed, 250),
  });

  await nc.flush();
  assertEquals(nc.isClosed(), false);
  await cleanup(ns, nc);
});

Deno.test("authenticator - async fn rejects", async () => {
  const asyncAuthenticator = (_nonce?: string): Promise<Auth> => {
    return Promise.reject(new Error("async authenticator blew up"));
  };

  await assertRejects(
    async () => {
      await setup({}, { asyncAuthenticator, reconnect: false });
    },
    Error,
  );
});

// This is the test that actually proves the awaitingAsyncConnect gate in
// ProtocolHandler.push() works, not just that the code compiles. It uses a
// very short server-side ping_interval against an authenticator delay long
// enough that the real nats-server (confirmed via its own source,
// server.go: "Set the Ping timer. Will be reset once connect was received")
// will send at least one unsolicited PING before this client's CONNECT is
// sent. If the gate didn't work — if that early PING were dispatched to
// processPing() and a PONG were written to a transport that hasn't sent
// CONNECT yet — this would either fail outright or leave the connection in
// a bad state. Success here means the race was hit and handled correctly,
// not that the race never happened.
Deno.test("authenticator - async fn ignores data before connect", async () => {
  const user = nkeys.createUser();
  const seed = user.getSeed();
  const nkey = user.getPublicKey();

  const { ns, nc } = await setup({
    authorization: {
      users: [{ nkey }],
    },
    // Aggressive on purpose — short enough that the server's ping timer
    // (armed immediately after INFO, per server.go) fires well within the
    // authenticator's artificial delay below. ping_max raised generously so
    // the several unanswered pings this produces (we're not able to PONG
    // until the gate opens) don't also trip the server's own unrelated
    // stale-connection detection — that's a real, separate server defense,
    // not what this test is isolating.
    ping_interval: "50ms",
    ping_max: 50,
  }, {
    asyncAuthenticator: delayedNkeyAsyncAuthenticator(seed, 500),
  });

  await nc.flush();
  assertEquals(nc.isClosed(), false);
  await cleanup(ns, nc);
});

// The server counts PINGs the client has not answered, and keeps counting
// them after CONNECT. Here the authenticator is slow enough to miss the
// server's one allowed PING (ping_max 1) but fast enough to send CONNECT
// before the server gives up on the connection (at 2 x ping_interval). With
// the PING simply dropped, the server closes the connection at its next check
// after CONNECT, and with reconnect off the client is closed. Answering it
// right after CONNECT clears the count.
Deno.test("authenticator - async fn: a PING missed while pending does not leave the connection stale", async () => {
  const user = nkeys.createUser();
  const seed = user.getSeed();
  const nkey = user.getPublicKey();

  const { ns, nc } = await setup({
    authorization: {
      users: [{ nkey }],
    },
    ping_interval: "500ms",
    ping_max: 1,
  }, {
    asyncAuthenticator: delayedNkeyAsyncAuthenticator(seed, 750),
    reconnect: false,
  });

  // several server ping intervals after CONNECT
  await delay(1600);
  assertEquals(nc.isClosed(), false);
  await nc.flush();
  await cleanup(ns, nc);
});

// The server rejects a PONG sent before CONNECT (Authorization Violation), so
// the PONG for a PING that arrived while the authenticator was pending must
// follow CONNECT, and one is enough however many PINGs were missed.
Deno.test("authenticator - async fn: PONG for a missed PING follows CONNECT, once", async () => {
  const lines: string[] = [];
  const sockets: Socket[] = [];
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    let partial = "";
    sock.on("data", (b: Buffer) => {
      const parts = (partial + b.toString()).split("\r\n");
      partial = parts.pop() ?? "";
      for (const line of parts) {
        lines.push(line.startsWith("CONNECT ") ? "CONNECT" : line);
        if (line === "PING") {
          sock.write("PONG\r\n");
        }
      }
    });
    const info = JSON.stringify({
      server_id: "SCRIPTED",
      version: "2.10.0",
      host: "127.0.0.1",
      port: 0,
      headers: true,
      nonce: "n",
    });
    sock.write(`INFO ${info}\r\nPING\r\nPING\r\n`);
  });
  const ready = deferred<void>();
  let port = 0;
  server.listen(0, "127.0.0.1", () => {
    port = (server.address() as AddressInfo).port;
    ready.resolve();
  });
  await ready;
  try {
    const nc = await connect({
      port,
      reconnect: false,
      asyncAuthenticator: async () => {
        await delay(200);
        return { auth_token: "x" };
      },
    });
    // CONNECT, the client's own PING that connect() waits on, then the owed
    // PONG; nothing from the client precedes CONNECT
    assertEquals(lines.slice(0, 3), ["CONNECT", "PING", "PONG"]);
    assertEquals(lines.filter((l) => l === "PONG").length, 1);
    await nc.close();
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// A server that sends INFO (with a nonce) and a PING, then an -ERR after
// `afterMs`, and leaves the socket open, recording every CONNECT it receives.
// Leaving the socket open isolates what the client does on its own: with a
// real server the socket closing would end the attempt regardless.
async function errServer(err: string, afterMs: number) {
  const connects: string[] = [];
  const sockets: Socket[] = [];
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    sock.on("data", (b: Buffer) => {
      for (const line of b.toString().split("\r\n")) {
        if (line.startsWith("CONNECT ")) {
          connects.push(line);
        }
      }
    });
    const info = JSON.stringify({
      server_id: "SCRIPTED",
      version: "2.10.0",
      host: "127.0.0.1",
      port: 0,
      headers: true,
      nonce: "n",
    });
    sock.write(`INFO ${info}\r\nPING\r\n`);
    setTimeout(() => sock.write(`-ERR '${err}'\r\n`), afterMs);
  });
  const ready = deferred<void>();
  let port = 0;
  server.listen(0, "127.0.0.1", () => {
    port = (server.address() as AddressInfo).port;
    ready.resolve();
  });
  await ready;
  return {
    port,
    connects,
    async stop() {
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// The server gives up on a connection that is still waiting for its
// authenticator. The -ERR must be handled immediately - not dropped with the
// rest of the pre-CONNECT traffic, which would leave connect() waiting for
// the dial timeout and lose the server's explanation.
Deno.test("authenticator - async fn: server -ERR preempts a pending authenticator", async () => {
  const release = deferred<void>();
  const srv = await errServer("Authentication Timeout", 100);
  try {
    let signed = false;
    const started = Date.now();
    const err = await assertRejects(() =>
      connect({
        port: srv.port,
        reconnect: false,
        asyncAuthenticator: async () => {
          await release;
          signed = true;
          return { auth_token: "x" };
        },
      })
    );
    assertInstanceOf(err, AuthorizationError);
    assertEquals(signed, false, "reported while the authenticator was pending");
    assertBetween(Date.now() - started, 50, 1500);

    // the authenticator finishing later must not send CONNECT
    release.resolve();
    await delay(200);
    assertEquals(srv.connects.length, 0);
  } finally {
    release.resolve();
    await srv.stop();
  }
});

// A non-auth -ERR does not reject connect() and the server here keeps the
// socket open, so nothing else ends the attempt: only the -ERR handling in
// push() stops the authenticator's late result from sending a CONNECT into a
// connection the server has already given up on.
Deno.test("authenticator - async fn: -ERR ends the attempt, a late resolution sends no CONNECT", async () => {
  const srv = await errServer("Stale Connection", 100);
  try {
    let signed = false;
    const rejected = assertRejects(() =>
      connect({
        port: srv.port,
        reconnect: false,
        timeout: 1500,
        asyncAuthenticator: async () => {
          await delay(500);
          signed = true;
          return { auth_token: "x" };
        },
      })
    );
    await delay(900);
    assertEquals(signed, true, "the authenticator did finish");
    assertEquals(srv.connects.length, 0, "but its result was discarded");
    // nothing closes this connect(); it ends on the dial timeout
    await rejected;
  } finally {
    await srv.stop();
  }
});

Deno.test("authenticator - async fn: real server's Authentication Timeout is reported while the authenticator is still pending", async () => {
  const ns = await NatsServer.start({
    authorization: { token: "s3cret", timeout: 1 },
  });
  const release = deferred<void>();
  try {
    let signed = false;
    const err = await assertRejects(() =>
      ns.connect({
        reconnect: false,
        asyncAuthenticator: async () => {
          await release;
          signed = true;
          return { auth_token: "s3cret" };
        },
      })
    );
    assertInstanceOf(err, AuthorizationError);
    assertEquals(signed, false);
  } finally {
    release.resolve();
    await ns.stop(true);
  }
});

// ---- webCryptoJwtAuthenticator --------------------------------------------------------------------------
// The helper that turns WebCrypto's raw public key into the nkey text a user JWT's `sub` needs is checked here
// against this package's own nkeys parser, so a wrong prefix or checksum cannot slip through.

async function generatePair(extractable = false): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey({ name: "Ed25519" }, extractable, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
}

Deno.test("webcrypto - nkeyFromWebCryptoPublicKey: a valid user nkey that parses back to the same public key", async () => {
  const kp = await generatePair();
  const nkey = await nkeyFromWebCryptoPublicKey(kp.publicKey);
  assertEquals(nkey.length, 56);
  assertEquals(nkey[0], "U");
  // fromPublic validates the prefix and the checksum, and getPublicKey returns the same text.
  assertEquals(nkeys.fromPublic(nkey).getPublicKey(), nkey);
  // and it is the key it claims to be: a signature made with the private half verifies against the parsed nkey
  const data = new TextEncoder().encode("a nonce");
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, data),
  );
  assertEquals(nkeys.fromPublic(nkey).verify(data, sig), true);
});

Deno.test("webcrypto - webCryptoJwtAuthenticator: presents the jwt, the nkey, and a signature over the nonce", async () => {
  const kp = await generatePair();
  const auth = webCryptoJwtAuthenticator({ keyPair: kp, jwt: "the.user.jwt" });
  const result = await auth("server-nonce") as unknown as Record<
    string,
    string
  >;
  assertEquals(result.jwt, "the.user.jwt");
  assertEquals(result.nkey, await nkeyFromWebCryptoPublicKey(kp.publicKey));
  assertEquals(result.auth_token, undefined);
  const sig = Uint8Array.from(atob(result.sig), (c) => c.charCodeAt(0));
  assertEquals(
    nkeys.fromPublic(result.nkey).verify(
      new TextEncoder().encode("server-nonce"),
      sig,
    ),
    true,
  );
});

Deno.test("webcrypto - webCryptoJwtAuthenticator: jwt and authToken functions are read on every call", async () => {
  const kp = await generatePair();
  let n = 0;
  const auth = webCryptoJwtAuthenticator({
    keyPair: kp,
    jwt: () => `jwt-${++n}`,
    authToken: () => `token-${n}`,
  });
  const first = await auth("a") as unknown as Record<string, string>;
  const second = await auth("b") as unknown as Record<string, string>;
  assertEquals([first.jwt, first.auth_token], ["jwt-1", "token-1"]);
  assertEquals([second.jwt, second.auth_token], ["jwt-2", "token-2"]);
  assertEquals(first.nkey, second.nkey);
});

Deno.test("webcrypto - webCryptoJwtAuthenticator: WebCrypto's own error is passed through for a key that cannot sign", async () => {
  const ecdsa = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const edPublicOnly = await generatePair();
  const wrongAlgorithm = webCryptoJwtAuthenticator({
    keyPair: {
      publicKey: edPublicOnly.publicKey,
      privateKey: ecdsa.privateKey,
    },
    jwt: "j",
  });
  const err = await assertRejects(() => wrongAlgorithm("n"));
  assertEquals((err as DOMException).name, "InvalidAccessError");
});

// This is the actual end-to-end proof that the chain of trust from a
// constructed, key-bound JWT to the server's nonce-signature verification is
// unbroken: a JWT whose `sub` names one WebCrypto key pair's public half must
// only ever be usable by the connection that holds that key pair's private
// half. Two *different*, real, non-extractable WebCrypto-generated Ed25519
// key pairs stand in for "a legitimate holder" and "an attacker who has
// somehow obtained a copy of the JWT but not the matching private key": the
// second one tries to connect with kp1's JWT while signing with kp2's key.
Deno.test("authenticator - async fn: a JWT bound to one WebCrypto key pair is rejected when signed with a different one", async () => {
  const O = nkeys.createOperator();
  const A = nkeys.createAccount();

  const kp1 = await generatePair();
  const kp2 = await generatePair();
  const pub1 = await nkeyFromWebCryptoPublicKey(kp1.publicKey);

  // The JWT's sub is pub1 only. encodeUser's second parameter accepts a bare
  // nkey string (jsr:@nats-io/jwt's Key = string | Uint8Array | KeyPair) —
  // exactly what a WebCrypto-only identity has, since there is no nkeys
  // KeyPair wrapping a non-extractable key.
  const ujwt = await encodeUser("U", pub1, A, {});

  const resolver: Record<string, string> = {};
  resolver[A.getPublicKey()] = await encodeAccount("A", A, {
    limits: { conn: -1, subs: -1 },
  }, { signer: O });
  const conf = {
    operator: await encodeOperator("O", O),
    resolver: "MEMORY",
    "resolver_preload": resolver,
  };

  const ns = await NatsServer.start(conf);
  try {
    // The spoof attempt: kp1's JWT, but signed (and identified, by nkey) with
    // kp2. If the server accepted this, the JWT's sub binding would be
    // decorative rather than load-bearing — exactly the property this fork's
    // AsyncAuthenticator (and the browser PoP flow it exists for) depends on.
    const err = await assertRejects(() =>
      ns.connect({
        reconnect: false,
        asyncAuthenticator: webCryptoJwtAuthenticator({
          keyPair: kp2,
          jwt: ujwt,
        }),
      })
    );
    assertInstanceOf(err, AuthorizationError);
    // Specifically an authorization rejection, not a connection that merely
    // never completed. This is what rules out a dropped or mishandled PING
    // as the actual cause — a real failure mode in this codebase's own
    // history (see "async fn ignores data before connect" and "async fn:
    // server -ERR preempts a pending authenticator", above): those would
    // surface as a timeout or a closed connection with no server -ERR at
    // all, never as an AuthorizationError carrying this message.
    assertStringIncludes(
      (err as Error).message.toLowerCase(),
      "authorization violation",
    );

    // Positive control: same server, same async-signing pathway, same
    // absence of any artificial delay — kp1 signing for its own JWT
    // succeeds. This is what isolates the rejection above to the key
    // mismatch specifically: if PINGs, or anything else about this async
    // path, were the real problem, this connection would fail too.
    const nc = await ns.connect({
      reconnect: false,
      asyncAuthenticator: webCryptoJwtAuthenticator({
        keyPair: kp1,
        jwt: ujwt,
      }),
    });
    await nc.flush();
    assertEquals(nc.isClosed(), false);
    await nc.close();
  } finally {
    await ns.stop(true);
  }
});
