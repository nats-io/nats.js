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

// End-to-end example: authenticating with a non-extractable WebCrypto key,
// the way a browser does, against a real nats-server.
//
//   deno run -A core/examples/webcrypto-auth.ts
//
// Needs `nats-server` on the PATH. It plays two roles in one process, and says
// which it is playing at each step:
//
//   - the operator's side: creates the operator and account, starts the server
//     in operator (JWT) mode with a websocket listener, and, once it is told a
//     user's public key, signs a user JWT for it. In a real deployment the
//     signing happens in a service you run; the account's signing key never
//     reaches the client.
//   - the client's side: generates a key pair with WebCrypto, keeps the private
//     key non-extractable, asks the other role for a JWT, and connects over a
//     websocket (the transport a browser uses) with webCryptoJwtAuthenticator.
//
// It then shows what the binding buys: the same JWT, presented by a client
// holding a different key, is refused by the server.
import {
  nkeyFromWebCryptoPublicKey,
  nkeys,
  webCryptoJwtAuthenticator,
  wsconnect,
} from "../src/mod.ts";
import { encodeAccount, encodeOperator, encodeUser } from "@nats-io/jwt";

const say = (role: string, text: string) =>
  console.log(`[${role.padEnd(8)}] ${text}`);

// ---- the operator's side: a server that only accepts JWTs signed by this account
async function startServer() {
  try {
    await new Deno.Command("nats-server", { args: ["--version"] }).output();
  } catch {
    console.error(
      "nats-server was not found on the PATH. Install it (https://docs.nats.io/running-a-nats-service/introduction/installation) and run this again.",
    );
    Deno.exit(1);
  }

  const operator = nkeys.createOperator();
  const account = nkeys.createAccount();
  const freePort = () => {
    const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
    const port = (l.addr as Deno.NetAddr).port;
    l.close();
    return port;
  };
  const wsPort = freePort();

  const conf = {
    port: freePort(),
    websocket: { port: wsPort, no_tls: true },
    operator: await encodeOperator("example-operator", operator),
    resolver: "MEMORY",
    resolver_preload: {
      [account.getPublicKey()]: await encodeAccount(
        "example-account",
        account,
        {
          // -1 is unlimited; an account JWT that leaves payload and data unset gets a max payload of 0
          limits: { conn: -1, subs: -1, data: -1, payload: -1 },
        },
        { signer: operator },
      ),
    },
  };
  const dir = await Deno.makeTempDir({ prefix: "webcrypto-auth-" });
  const confFile = `${dir}/nats-server.conf`;
  await Deno.writeTextFile(confFile, JSON.stringify(conf));

  const server = new Deno.Command("nats-server", {
    args: ["-c", confFile],
    stdout: "null",
    stderr: "null",
  }).spawn();

  // wait for the websocket listener
  for (let i = 0; i < 50; i++) {
    try {
      (await Deno.connect({ port: wsPort, hostname: "127.0.0.1" })).close();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
      if (i === 49) throw new Error("nats-server did not start");
    }
  }
  say(
    "operator",
    `nats-server is up in operator mode, websocket on ws://127.0.0.1:${wsPort}`,
  );

  return {
    url: `ws://127.0.0.1:${wsPort}`,
    // The service that holds the account signing key. It sees only a PUBLIC key.
    mintUserJwt: (userNkey: string) =>
      encodeUser("example-user", userNkey, account, {}),
    stop: async () => {
      server.kill();
      await server.status;
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const operatorSide = await startServer();
try {
  // ---- the client's side: a key that never leaves WebCrypto
  const keyPair = await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  say(
    "client",
    `generated an Ed25519 key pair; the private key is extractable: ${keyPair.privateKey.extractable}`,
  );
  const userNkey = await nkeyFromWebCryptoPublicKey(keyPair.publicKey);
  say("client", `its public key as an nkey: ${userNkey}`);

  // ---- the operator's side signs a JWT whose subject is that public key
  const jwt = await operatorSide.mintUserJwt(userNkey);
  say(
    "operator",
    `signed a user JWT for ${
      userNkey.slice(0, 8)
    }... (${jwt.length} characters)`,
  );

  // ---- the client connects: the server sends a nonce, WebCrypto signs it, no secret is exported
  const nc = await wsconnect({
    servers: operatorSide.url,
    reconnect: false,
    asyncAuthenticator: webCryptoJwtAuthenticator({ keyPair, jwt }),
  });
  say(
    "client",
    "connected with the JWT and a signature made by the non-extractable key",
  );

  const sub = nc.subscribe("example.hello");
  nc.publish("example.hello", "hello from a key that cannot be exported");
  for await (const m of sub) {
    say("client", `received: ${m.string()}`);
    break;
  }
  await nc.close();

  // ---- what the binding buys: the same JWT with a different key is refused
  const otherKeyPair = await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  try {
    await wsconnect({
      servers: operatorSide.url,
      reconnect: false,
      asyncAuthenticator: webCryptoJwtAuthenticator({
        keyPair: otherKeyPair,
        jwt,
      }),
    });
    say(
      "attacker",
      "UNEXPECTED: the server accepted a JWT signed with the wrong key",
    );
    Deno.exitCode = 1;
  } catch (err) {
    say(
      "attacker",
      `holding the same JWT but a different key: refused (${
        (err as Error).message
      })`,
    );
  }
} finally {
  await operatorSide.stop();
}
