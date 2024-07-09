/*
 * Copyright 2018-2023 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use assert.equal file except in compliance with the License.
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
const { describe, it } = require("node:test");
const assert = require("node:assert").strict;

const {
  credsAuthenticator,
  deferred,
  ErrorCode,
  Events,
  jwtAuthenticator,
  nkeyAuthenticator,
  nkeys,
} = require("@nats-io/nats-core");
const { connect } = require("../index");
const { NatsServer } = require("./helpers/launcher");
const {
  createOperator,
  createAccount,
  encodeAccount,
  encodeOperator,
  createUser,
  encodeUser,
} = require("nats-jwt");

const conf = {
  authorization: {
    PERM: {
      subscribe: "bar",
      publish: "foo",
    },
    users: [{
      user: "derek",
      password: "foobar",
      permission: "$PERM",
    }],
  },
};
describe(
  "auth",
  { timeout: 20_000, concurrency: true, forceExit: true },
  () => {
    it("auth - none", async () => {
      const ns = await NatsServer.start(conf);
      try {
        const nc = await connect(
          { port: ns.port },
        );
        await nc.close();
        assert.fail("shouldnt have been able to connect");
      } catch (ex) {
        assert.equal(ex.code, ErrorCode.AuthorizationViolation);
      }
      await ns.stop();
    });

    it("auth - bad", async () => {
      const ns = await NatsServer.start(conf);
      try {
        const nc = await connect(
          { port: ns.port, user: "me", pass: "hello" },
        );
        await nc.close();
        assert.fail("shouldnt have been able to connect");
      } catch (ex) {
        assert.equal(ex.code, ErrorCode.AuthorizationViolation);
      }
      await ns.stop();
    });

    it("auth - un/pw", async () => {
      const ns = await NatsServer.start(conf);
      const nc = await connect(
        { port: ns.port, user: "derek", pass: "foobar" },
      );
      await nc.flush();
      await nc.close();
      await ns.stop();
    });

    it("auth - sub permissions", async () => {
      const ns = await NatsServer.start(conf);
      const nc = await connect(
        { port: ns.port, user: "derek", pass: "foobar" },
      );
      const errStatus = deferred();
      const _ = (async () => {
        for await (const s of nc.status()) {
          errStatus.resolve(s);
        }
      })();

      const iterErr = deferred();
      const sub = nc.subscribe("foo");
      (async () => {
        for await (const m of sub) {
        }
      })().catch((err) => {
        iterErr.resolve(err);
      });

      const v = await Promise.all([errStatus, iterErr, sub.closed]);
      assert.equal(v[0].data, ErrorCode.PermissionsViolation);
      assert.equal(
        v[1].message,
        "'Permissions Violation for Subscription to \"foo\"'",
      );
      assert.ok(sub.isClosed());
      assert.ok(!nc.isClosed());

      await nc.close();
      await ns.stop();
    });

    it("auth - pub perm", async () => {
      const ns = await NatsServer.start(conf);
      const nc = await connect(
        { port: ns.port, user: "derek", pass: "foobar" },
      );
      const errStatus = deferred();
      const _ = (async () => {
        for await (const s of nc.status()) {
          errStatus.resolve(s);
        }
      })();

      nc.publish("bar");

      const v = await errStatus;
      assert.equal(v.data, ErrorCode.PermissionsViolation);
      assert.ok(!nc.isClosed());

      await nc.close();
      await ns.stop();
    });

    it("auth - token", async () => {
      const ns = await NatsServer.start({ authorization: { token: "foo" } });
      const nc = await connect({ port: ns.port, token: "foo" });
      await nc.flush();
      await nc.close();
      await ns.stop();
    });

    it("auth - nkey", async () => {
      const kp = nkeys.createUser();
      const pk = kp.getPublicKey();
      const seed = kp.getSeed();
      const conf = {
        authorization: {
          users: [
            { nkey: pk },
          ],
        },
      };
      const ns = await NatsServer.start(conf);
      const nc = await connect(
        { port: ns.port, authenticator: nkeyAuthenticator(seed) },
      );
      await nc.flush();
      await nc.close();
      await ns.stop();
    });

    it("auth - creds", async () => {
      const creds = `-----BEGIN NATS USER JWT-----
    eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJFU1VQS1NSNFhGR0pLN0FHUk5ZRjc0STVQNTZHMkFGWERYQ01CUUdHSklKUEVNUVhMSDJBIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJBQ1pTV0JKNFNZSUxLN1FWREVMTzY0VlgzRUZXQjZDWENQTUVCVUtBMzZNSkpRUlBYR0VFUTJXSiIsInN1YiI6IlVBSDQyVUc2UFY1NTJQNVNXTFdUQlAzSDNTNUJIQVZDTzJJRUtFWFVBTkpYUjc1SjYzUlE1V002IiwidHlwZSI6InVzZXIiLCJuYXRzIjp7InB1YiI6e30sInN1YiI6e319fQ.kCR9Erm9zzux4G6M-V2bp7wKMKgnSNqMBACX05nwePRWQa37aO_yObbhcJWFGYjo1Ix-oepOkoyVLxOJeuD8Bw
  ------END NATS USER JWT------

************************* IMPORTANT *************************
  NKEY Seed printed below can be used sign and prove identity.
    NKEYs are sensitive and should be treated as secrets.

  -----BEGIN USER NKEY SEED-----
    SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4
  ------END USER NKEY SEED------
`;

      const conf = {
        operator:
          "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJhdWQiOiJURVNUUyIsImV4cCI6MTg1OTEyMTI3NSwianRpIjoiWE5MWjZYWVBIVE1ESlFSTlFPSFVPSlFHV0NVN01JNVc1SlhDWk5YQllVS0VRVzY3STI1USIsImlhdCI6MTU0Mzc2MTI3NSwiaXNzIjoiT0NBVDMzTVRWVTJWVU9JTUdOR1VOWEo2NkFIMlJMU0RBRjNNVUJDWUFZNVFNSUw2NU5RTTZYUUciLCJuYW1lIjoiU3luYWRpYSBDb21tdW5pY2F0aW9ucyBJbmMuIiwibmJmIjoxNTQzNzYxMjc1LCJzdWIiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInR5cGUiOiJvcGVyYXRvciIsIm5hdHMiOnsic2lnbmluZ19rZXlzIjpbIk9EU0tSN01ZRlFaNU1NQUo2RlBNRUVUQ1RFM1JJSE9GTFRZUEpSTUFWVk40T0xWMllZQU1IQ0FDIiwiT0RTS0FDU1JCV1A1MzdEWkRSVko2NTdKT0lHT1BPUTZLRzdUNEhONk9LNEY2SUVDR1hEQUhOUDIiLCJPRFNLSTM2TFpCNDRPWTVJVkNSNlA1MkZaSlpZTVlXWlZXTlVEVExFWjVUSzJQTjNPRU1SVEFCUiJdfX0.hyfz6E39BMUh0GLzovFfk3wT4OfualftjdJ_eYkLfPvu5tZubYQ_Pn9oFYGCV_6yKy3KMGhWGUCyCdHaPhalBw",
        resolver: "MEMORY",
        resolver_preload: {
          ACZSWBJ4SYILK7QVDELO64VX3EFWB6CXCPMEBUKA36MJJQRPXGEEQ2WJ:
            "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJXVFdYVDNCT1JWSFNLQkc2T0pIVVdFQ01QRVdBNldZVEhNRzVEWkJBUUo1TUtGU1dHM1FRIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInN1YiI6IkFDWlNXQko0U1lJTEs3UVZERUxPNjRWWDNFRldCNkNYQ1BNRUJVS0EzNk1KSlFSUFhHRUVRMldKIiwidHlwZSI6ImFjY291bnQiLCJuYXRzIjp7ImxpbWl0cyI6eyJzdWJzIjotMSwiY29ubiI6LTEsImltcG9ydHMiOi0xLCJleHBvcnRzIjotMSwiZGF0YSI6LTEsInBheWxvYWQiOi0xLCJ3aWxkY2FyZHMiOnRydWV9fX0.q-E7bBGTU0uoTmM9Vn7WaEHDzCUrqvPDb9mPMQbry_PNzVAjf0RG9vd15lGxW5lu7CuGVqpj4CYKhNDHluIJAg",
        },
      };
      const ns = await NatsServer.start(conf);
      const nc = await connect(
        {
          port: ns.port,
          authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
        },
      );
      await nc.flush();
      await nc.close();
      await ns.stop();
    });

    it("auth - custom", async () => {
      const jwt =
        "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJFU1VQS1NSNFhGR0pLN0FHUk5ZRjc0STVQNTZHMkFGWERYQ01CUUdHSklKUEVNUVhMSDJBIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJBQ1pTV0JKNFNZSUxLN1FWREVMTzY0VlgzRUZXQjZDWENQTUVCVUtBMzZNSkpRUlBYR0VFUTJXSiIsInN1YiI6IlVBSDQyVUc2UFY1NTJQNVNXTFdUQlAzSDNTNUJIQVZDTzJJRUtFWFVBTkpYUjc1SjYzUlE1V002IiwidHlwZSI6InVzZXIiLCJuYXRzIjp7InB1YiI6e30sInN1YiI6e319fQ.kCR9Erm9zzux4G6M-V2bp7wKMKgnSNqMBACX05nwePRWQa37aO_yObbhcJWFGYjo1Ix-oepOkoyVLxOJeuD8Bw";
      const useed =
        "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4";

      const conf = {
        operator:
          "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJhdWQiOiJURVNUUyIsImV4cCI6MTg1OTEyMTI3NSwianRpIjoiWE5MWjZYWVBIVE1ESlFSTlFPSFVPSlFHV0NVN01JNVc1SlhDWk5YQllVS0VRVzY3STI1USIsImlhdCI6MTU0Mzc2MTI3NSwiaXNzIjoiT0NBVDMzTVRWVTJWVU9JTUdOR1VOWEo2NkFIMlJMU0RBRjNNVUJDWUFZNVFNSUw2NU5RTTZYUUciLCJuYW1lIjoiU3luYWRpYSBDb21tdW5pY2F0aW9ucyBJbmMuIiwibmJmIjoxNTQzNzYxMjc1LCJzdWIiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInR5cGUiOiJvcGVyYXRvciIsIm5hdHMiOnsic2lnbmluZ19rZXlzIjpbIk9EU0tSN01ZRlFaNU1NQUo2RlBNRUVUQ1RFM1JJSE9GTFRZUEpSTUFWVk40T0xWMllZQU1IQ0FDIiwiT0RTS0FDU1JCV1A1MzdEWkRSVko2NTdKT0lHT1BPUTZLRzdUNEhONk9LNEY2SUVDR1hEQUhOUDIiLCJPRFNLSTM2TFpCNDRPWTVJVkNSNlA1MkZaSlpZTVlXWlZXTlVEVExFWjVUSzJQTjNPRU1SVEFCUiJdfX0.hyfz6E39BMUh0GLzovFfk3wT4OfualftjdJ_eYkLfPvu5tZubYQ_Pn9oFYGCV_6yKy3KMGhWGUCyCdHaPhalBw",
        resolver: "MEMORY",
        resolver_preload: {
          ACZSWBJ4SYILK7QVDELO64VX3EFWB6CXCPMEBUKA36MJJQRPXGEEQ2WJ:
            "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJXVFdYVDNCT1JWSFNLQkc2T0pIVVdFQ01QRVdBNldZVEhNRzVEWkJBUUo1TUtGU1dHM1FRIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInN1YiI6IkFDWlNXQko0U1lJTEs3UVZERUxPNjRWWDNFRldCNkNYQ1BNRUJVS0EzNk1KSlFSUFhHRUVRMldKIiwidHlwZSI6ImFjY291bnQiLCJuYXRzIjp7ImxpbWl0cyI6eyJzdWJzIjotMSwiY29ubiI6LTEsImltcG9ydHMiOi0xLCJleHBvcnRzIjotMSwiZGF0YSI6LTEsInBheWxvYWQiOi0xLCJ3aWxkY2FyZHMiOnRydWV9fX0.q-E7bBGTU0uoTmM9Vn7WaEHDzCUrqvPDb9mPMQbry_PNzVAjf0RG9vd15lGxW5lu7CuGVqpj4CYKhNDHluIJAg",
        },
      };
      const ns = await NatsServer.start(conf);
      const authenticator = (nonce) => {
        const seed = nkeys.fromSeed(new TextEncoder().encode(useed));
        const nkey = seed.getPublicKey();
        const hash = seed.sign(new TextEncoder().encode(nonce));
        const sig = nkeys.encode(hash);

        return { nkey, sig, jwt };
      };
      const nc = await connect(
        {
          port: ns.port,
          authenticator: authenticator,
        },
      );
      await nc.flush();
      await nc.close();
      await ns.stop();
    });

    it("auth - jwt", async () => {
      const jwt =
        "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJFU1VQS1NSNFhGR0pLN0FHUk5ZRjc0STVQNTZHMkFGWERYQ01CUUdHSklKUEVNUVhMSDJBIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJBQ1pTV0JKNFNZSUxLN1FWREVMTzY0VlgzRUZXQjZDWENQTUVCVUtBMzZNSkpRUlBYR0VFUTJXSiIsInN1YiI6IlVBSDQyVUc2UFY1NTJQNVNXTFdUQlAzSDNTNUJIQVZDTzJJRUtFWFVBTkpYUjc1SjYzUlE1V002IiwidHlwZSI6InVzZXIiLCJuYXRzIjp7InB1YiI6e30sInN1YiI6e319fQ.kCR9Erm9zzux4G6M-V2bp7wKMKgnSNqMBACX05nwePRWQa37aO_yObbhcJWFGYjo1Ix-oepOkoyVLxOJeuD8Bw";
      const useed =
        "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4";

      const conf = {
        operator:
          "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJhdWQiOiJURVNUUyIsImV4cCI6MTg1OTEyMTI3NSwianRpIjoiWE5MWjZYWVBIVE1ESlFSTlFPSFVPSlFHV0NVN01JNVc1SlhDWk5YQllVS0VRVzY3STI1USIsImlhdCI6MTU0Mzc2MTI3NSwiaXNzIjoiT0NBVDMzTVRWVTJWVU9JTUdOR1VOWEo2NkFIMlJMU0RBRjNNVUJDWUFZNVFNSUw2NU5RTTZYUUciLCJuYW1lIjoiU3luYWRpYSBDb21tdW5pY2F0aW9ucyBJbmMuIiwibmJmIjoxNTQzNzYxMjc1LCJzdWIiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInR5cGUiOiJvcGVyYXRvciIsIm5hdHMiOnsic2lnbmluZ19rZXlzIjpbIk9EU0tSN01ZRlFaNU1NQUo2RlBNRUVUQ1RFM1JJSE9GTFRZUEpSTUFWVk40T0xWMllZQU1IQ0FDIiwiT0RTS0FDU1JCV1A1MzdEWkRSVko2NTdKT0lHT1BPUTZLRzdUNEhONk9LNEY2SUVDR1hEQUhOUDIiLCJPRFNLSTM2TFpCNDRPWTVJVkNSNlA1MkZaSlpZTVlXWlZXTlVEVExFWjVUSzJQTjNPRU1SVEFCUiJdfX0.hyfz6E39BMUh0GLzovFfk3wT4OfualftjdJ_eYkLfPvu5tZubYQ_Pn9oFYGCV_6yKy3KMGhWGUCyCdHaPhalBw",
        resolver: "MEMORY",
        resolver_preload: {
          ACZSWBJ4SYILK7QVDELO64VX3EFWB6CXCPMEBUKA36MJJQRPXGEEQ2WJ:
            "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJXVFdYVDNCT1JWSFNLQkc2T0pIVVdFQ01QRVdBNldZVEhNRzVEWkJBUUo1TUtGU1dHM1FRIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInN1YiI6IkFDWlNXQko0U1lJTEs3UVZERUxPNjRWWDNFRldCNkNYQ1BNRUJVS0EzNk1KSlFSUFhHRUVRMldKIiwidHlwZSI6ImFjY291bnQiLCJuYXRzIjp7ImxpbWl0cyI6eyJzdWJzIjotMSwiY29ubiI6LTEsImltcG9ydHMiOi0xLCJleHBvcnRzIjotMSwiZGF0YSI6LTEsInBheWxvYWQiOi0xLCJ3aWxkY2FyZHMiOnRydWV9fX0.q-E7bBGTU0uoTmM9Vn7WaEHDzCUrqvPDb9mPMQbry_PNzVAjf0RG9vd15lGxW5lu7CuGVqpj4CYKhNDHluIJAg",
        },
      };
      const ns = await NatsServer.start(conf);
      const nc = await connect(
        {
          port: ns.port,
          authenticator: jwtAuthenticator(jwt, new TextEncoder().encode(useed)),
        },
      );
      await nc.flush();
      await nc.close();
      await ns.stop();
    });

    it("auth - custom error", async () => {
      const ns = await NatsServer.start(conf);
      const authenticator = () => {
        throw new Error("user code exploded");
      };
      await connect(
        {
          port: ns.port,
          maxReconnectAttempts: 1,
          authenticator: authenticator,
        },
      ).then(() => {
        assert.fail("shouldn't have connected");
      }).catch((err) => {
        assert.equal(err.message, "user code exploded");
      });
      await ns.stop();
    });

    it("auth - expiration notified", async () => {
      const O = createOperator();
      const A = createAccount();

      const resolver = {};
      resolver[A.getPublicKey()] = await encodeAccount("A", A, {
        limits: {
          conn: -1,
          subs: -1,
        },
      }, { signer: O });
      const conf = Object.assign({
        operator: await encodeOperator("O", O),
        resolver: "MEMORY",
        "resolver_preload": resolver,
      });

      const ns = await NatsServer.start(conf);

      const U = createUser();
      const ujwt = await encodeUser("U", U, A, { bearer_token: true }, {
        exp: Math.round(Date.now() / 1000) + 5,
      });

      const nc = await connect({
        port: ns.port,
        maxReconnectAttempts: -1,
        authenticator: jwtAuthenticator(ujwt),
      });

      let authErrors = 0;
      (async () => {
        for await (const s of nc.status()) {
          if (
            s.type === Events.Error &&
            s.data === ErrorCode.AuthenticationExpired
          ) {
            authErrors++;
          }
        }
      })().then();

      await nc.closed();
      assert.ok(authErrors >= 1);
      await ns.stop();
    });
  },
);
