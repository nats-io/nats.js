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
import { cleanup, connect, NatsServer, setup } from "test_helpers";
import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
  fail,
} from "jsr:@std/assert";
import {
  encodeAccount,
  encodeOperator,
  encodeUser,
} from "jsr:@nats-io/jwt@0.0.9-3";
import type {
  MsgImpl,
  NatsConnectionImpl,
  NKeyAuth,
  Status,
  UserPass,
} from "../src/internal_mod.ts";
import {
  createInbox,
  credsAuthenticator,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  deferred,
  Empty,
  jwtAuthenticator,
  nkeyAuthenticator,
  nkeys,
  tokenAuthenticator,
  usernamePasswordAuthenticator,
} from "../src/internal_mod.ts";
import { errors } from "../src/errors.ts";

const conf = {
  authorization: {
    users: [{
      user: "derek",
      password: "foobar",
      permission: {
        subscribe: "bar",
        publish: "foo",
      },
    }],
  },
};

Deno.test("auth - none", async () => {
  const ns = await NatsServer.start(conf);
  await assertRejects(
    () => {
      return ns.connect({ reconnect: false });
    },
    errors.AuthorizationError,
  );

  await ns.stop();
});

Deno.test("auth - bad", async () => {
  const ns = await NatsServer.start(conf);
  await assertRejects(
    () => {
      return ns.connect({ user: "me", pass: "hello" });
    },
    errors.AuthorizationError,
  );
  await ns.stop();
});

Deno.test("auth - weird chars", async () => {
  const pass = "§12§12§12";
  const ns = await NatsServer.start({
    authorization: {
      username: "admin",
      password: pass,
    },
  });

  const nc = await ns.connect({ user: "admin", pass: pass });
  await nc.flush();
  await nc.close();
  await ns.stop();
});

Deno.test("auth - un/pw", async () => {
  const ns = await NatsServer.start(conf);
  const nc = await ns.connect(
    { user: "derek", pass: "foobar" },
  );
  await nc.flush();
  await nc.close();
  await ns.stop();
});

Deno.test("auth - un/pw authenticator", async () => {
  const ns = await NatsServer.start(conf);
  const nc = await ns.connect(
    {
      authenticator: usernamePasswordAuthenticator("derek", "foobar"),
    },
  );
  await nc.flush();
  await nc.close();
  await ns.stop();
});

Deno.test("auth - sub no permissions keeps connection", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permissions: { subscribe: "foo" },
      }],
    },
  }, { user: "a", pass: "a", reconnect: false });

  const errStatus = deferred<Status>();
  (async () => {
    for await (const s of nc.status()) {
      errStatus.resolve(s);
    }
  })().then();

  const cbErr = deferred<Error | null>();
  const sub = nc.subscribe("bar", {
    callback: (err, _msg) => {
      cbErr.resolve(err);
    },
  });

  const v = await Promise.all([errStatus, cbErr, sub.closed]);
  assertEquals(v[0].type, "error");
  const ev = v[0] as ErrorEvent;
  assertEquals(
    ev.error.message,
    `Permissions Violation for Subscription to "bar"`,
  );
  assertEquals(
    v[1]?.message,
    `Permissions Violation for Subscription to "bar"`,
  );

  assertEquals(nc.isClosed(), false);

  await cleanup(ns, nc);
});

Deno.test("auth - sub iterator no permissions keeps connection", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permissions: { subscribe: "foo" },
      }],
    },
  }, { user: "a", pass: "a", reconnect: false });

  const errStatus = deferred<Status>();
  (async () => {
    for await (const s of nc.status()) {
      errStatus.resolve(s);
    }
  })().then();

  const iterErr = deferred<Error | null>();
  const sub = nc.subscribe("bar");
  (async () => {
    for await (const _m of sub) {
      // ignored
    }
  })().catch((err) => {
    iterErr.resolve(err);
  });

  await nc.flush();

  const v = await Promise.all([errStatus, iterErr, sub.closed]);
  assertEquals(v[0].type, "error");
  const ev = v[0] as ErrorEvent;
  assertEquals(
    ev.error.message,
    `Permissions Violation for Subscription to "bar"`,
  );
  assertEquals(
    v[1]?.message,
    `Permissions Violation for Subscription to "bar"`,
  );
  assertEquals(sub.isClosed(), true);
  assertEquals(nc.isClosed(), false);

  await cleanup(ns, nc);
});

Deno.test("auth - pub permissions keep connection", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permissions: { publish: "foo" },
      }],
    },
  }, { user: "a", pass: "a", reconnect: false });

  const errStatus = deferred<Status>();
  (async () => {
    for await (const s of nc.status()) {
      errStatus.resolve(s);
    }
  })().then();

  nc.publish("bar");

  const v = await errStatus;
  assertEquals(v.type, "error");
  const ev = v as ErrorEvent;
  assertEquals(ev.error.message, `Permissions Violation for Publish to "bar"`);
  assertEquals(nc.isClosed(), false);

  await cleanup(ns, nc);
});

Deno.test("auth - req permissions keep connection", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permissions: { publish: "foo" },
      }],
    },
  }, { user: "a", pass: "a", reconnect: false });

  const errStatus = deferred<Status>();
  (async () => {
    for await (const s of nc.status()) {
      errStatus.resolve(s);
    }
  })().then();

  await assertRejects(
    async () => {
      await nc.request("bar");
    },
    errors.RequestError,
    `Permissions Violation for Publish to "bar"`,
  );

  const v = await errStatus;
  assertEquals(v.type, "error");
  const ev = v as ErrorEvent;
  assertEquals(ev.error.message, `Permissions Violation for Publish to "bar"`);
  assertEquals(nc.isClosed(), false);

  await cleanup(ns, nc);
});

Deno.test("auth - token", async () => {
  const { ns, nc } = await setup({ authorization: { token: "foo" } }, {
    token: "foo",
  });
  await nc.flush();
  await cleanup(ns, nc);
});

Deno.test("auth - token authenticator", async () => {
  const ns = await NatsServer.start({ authorization: { token: "foo" } });
  const nc = await ns.connect({
    authenticator: tokenAuthenticator("foo"),
  });
  await nc.flush();
  await nc.close();
  await ns.stop();
});

Deno.test("auth - nkey", async () => {
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
  const nc = await ns.connect(
    { authenticator: nkeyAuthenticator(seed) },
  );
  await nc.flush();
  await nc.close();
  await ns.stop();
});

Deno.test("auth - creds", async () => {
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
    "resolver_preload": {
      ACZSWBJ4SYILK7QVDELO64VX3EFWB6CXCPMEBUKA36MJJQRPXGEEQ2WJ:
        "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJXVFdYVDNCT1JWSFNLQkc2T0pIVVdFQ01QRVdBNldZVEhNRzVEWkJBUUo1TUtGU1dHM1FRIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInN1YiI6IkFDWlNXQko0U1lJTEs3UVZERUxPNjRWWDNFRldCNkNYQ1BNRUJVS0EzNk1KSlFSUFhHRUVRMldKIiwidHlwZSI6ImFjY291bnQiLCJuYXRzIjp7ImxpbWl0cyI6eyJzdWJzIjotMSwiY29ubiI6LTEsImltcG9ydHMiOi0xLCJleHBvcnRzIjotMSwiZGF0YSI6LTEsInBheWxvYWQiOi0xLCJ3aWxkY2FyZHMiOnRydWV9fX0.q-E7bBGTU0uoTmM9Vn7WaEHDzCUrqvPDb9mPMQbry_PNzVAjf0RG9vd15lGxW5lu7CuGVqpj4CYKhNDHluIJAg",
    },
  };
  const ns = await NatsServer.start(conf);
  const nc = await ns.connect(
    {
      authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    },
  );
  await nc.flush();
  await nc.close();
  await ns.stop();
});

Deno.test("auth - custom", async () => {
  const jwt =
    "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJFU1VQS1NSNFhGR0pLN0FHUk5ZRjc0STVQNTZHMkFGWERYQ01CUUdHSklKUEVNUVhMSDJBIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJBQ1pTV0JKNFNZSUxLN1FWREVMTzY0VlgzRUZXQjZDWENQTUVCVUtBMzZNSkpRUlBYR0VFUTJXSiIsInN1YiI6IlVBSDQyVUc2UFY1NTJQNVNXTFdUQlAzSDNTNUJIQVZDTzJJRUtFWFVBTkpYUjc1SjYzUlE1V002IiwidHlwZSI6InVzZXIiLCJuYXRzIjp7InB1YiI6e30sInN1YiI6e319fQ.kCR9Erm9zzux4G6M-V2bp7wKMKgnSNqMBACX05nwePRWQa37aO_yObbhcJWFGYjo1Ix-oepOkoyVLxOJeuD8Bw";
  const useed = "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4";

  const conf = {
    operator:
      "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJhdWQiOiJURVNUUyIsImV4cCI6MTg1OTEyMTI3NSwianRpIjoiWE5MWjZYWVBIVE1ESlFSTlFPSFVPSlFHV0NVN01JNVc1SlhDWk5YQllVS0VRVzY3STI1USIsImlhdCI6MTU0Mzc2MTI3NSwiaXNzIjoiT0NBVDMzTVRWVTJWVU9JTUdOR1VOWEo2NkFIMlJMU0RBRjNNVUJDWUFZNVFNSUw2NU5RTTZYUUciLCJuYW1lIjoiU3luYWRpYSBDb21tdW5pY2F0aW9ucyBJbmMuIiwibmJmIjoxNTQzNzYxMjc1LCJzdWIiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInR5cGUiOiJvcGVyYXRvciIsIm5hdHMiOnsic2lnbmluZ19rZXlzIjpbIk9EU0tSN01ZRlFaNU1NQUo2RlBNRUVUQ1RFM1JJSE9GTFRZUEpSTUFWVk40T0xWMllZQU1IQ0FDIiwiT0RTS0FDU1JCV1A1MzdEWkRSVko2NTdKT0lHT1BPUTZLRzdUNEhONk9LNEY2SUVDR1hEQUhOUDIiLCJPRFNLSTM2TFpCNDRPWTVJVkNSNlA1MkZaSlpZTVlXWlZXTlVEVExFWjVUSzJQTjNPRU1SVEFCUiJdfX0.hyfz6E39BMUh0GLzovFfk3wT4OfualftjdJ_eYkLfPvu5tZubYQ_Pn9oFYGCV_6yKy3KMGhWGUCyCdHaPhalBw",
    resolver: "MEMORY",
    "resolver_preload": {
      ACZSWBJ4SYILK7QVDELO64VX3EFWB6CXCPMEBUKA36MJJQRPXGEEQ2WJ:
        "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJXVFdYVDNCT1JWSFNLQkc2T0pIVVdFQ01QRVdBNldZVEhNRzVEWkJBUUo1TUtGU1dHM1FRIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInN1YiI6IkFDWlNXQko0U1lJTEs3UVZERUxPNjRWWDNFRldCNkNYQ1BNRUJVS0EzNk1KSlFSUFhHRUVRMldKIiwidHlwZSI6ImFjY291bnQiLCJuYXRzIjp7ImxpbWl0cyI6eyJzdWJzIjotMSwiY29ubiI6LTEsImltcG9ydHMiOi0xLCJleHBvcnRzIjotMSwiZGF0YSI6LTEsInBheWxvYWQiOi0xLCJ3aWxkY2FyZHMiOnRydWV9fX0.q-E7bBGTU0uoTmM9Vn7WaEHDzCUrqvPDb9mPMQbry_PNzVAjf0RG9vd15lGxW5lu7CuGVqpj4CYKhNDHluIJAg",
    },
  };
  const ns = await NatsServer.start(conf);
  const authenticator = (nonce?: string) => {
    const seed = nkeys.fromSeed(new TextEncoder().encode(useed));
    const nkey = seed.getPublicKey();
    const hash = seed.sign(new TextEncoder().encode(nonce));
    const sig = nkeys.encode(hash);

    return { nkey, sig, jwt };
  };
  const nc = await ns.connect(
    {
      authenticator: authenticator,
    },
  );
  await nc.flush();
  await nc.close();
  await ns.stop();
});

Deno.test("auth - jwt", async () => {
  const jwt =
    "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJFU1VQS1NSNFhGR0pLN0FHUk5ZRjc0STVQNTZHMkFGWERYQ01CUUdHSklKUEVNUVhMSDJBIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJBQ1pTV0JKNFNZSUxLN1FWREVMTzY0VlgzRUZXQjZDWENQTUVCVUtBMzZNSkpRUlBYR0VFUTJXSiIsInN1YiI6IlVBSDQyVUc2UFY1NTJQNVNXTFdUQlAzSDNTNUJIQVZDTzJJRUtFWFVBTkpYUjc1SjYzUlE1V002IiwidHlwZSI6InVzZXIiLCJuYXRzIjp7InB1YiI6e30sInN1YiI6e319fQ.kCR9Erm9zzux4G6M-V2bp7wKMKgnSNqMBACX05nwePRWQa37aO_yObbhcJWFGYjo1Ix-oepOkoyVLxOJeuD8Bw";
  const useed = "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4";

  const conf = {
    operator:
      "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJhdWQiOiJURVNUUyIsImV4cCI6MTg1OTEyMTI3NSwianRpIjoiWE5MWjZYWVBIVE1ESlFSTlFPSFVPSlFHV0NVN01JNVc1SlhDWk5YQllVS0VRVzY3STI1USIsImlhdCI6MTU0Mzc2MTI3NSwiaXNzIjoiT0NBVDMzTVRWVTJWVU9JTUdOR1VOWEo2NkFIMlJMU0RBRjNNVUJDWUFZNVFNSUw2NU5RTTZYUUciLCJuYW1lIjoiU3luYWRpYSBDb21tdW5pY2F0aW9ucyBJbmMuIiwibmJmIjoxNTQzNzYxMjc1LCJzdWIiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInR5cGUiOiJvcGVyYXRvciIsIm5hdHMiOnsic2lnbmluZ19rZXlzIjpbIk9EU0tSN01ZRlFaNU1NQUo2RlBNRUVUQ1RFM1JJSE9GTFRZUEpSTUFWVk40T0xWMllZQU1IQ0FDIiwiT0RTS0FDU1JCV1A1MzdEWkRSVko2NTdKT0lHT1BPUTZLRzdUNEhONk9LNEY2SUVDR1hEQUhOUDIiLCJPRFNLSTM2TFpCNDRPWTVJVkNSNlA1MkZaSlpZTVlXWlZXTlVEVExFWjVUSzJQTjNPRU1SVEFCUiJdfX0.hyfz6E39BMUh0GLzovFfk3wT4OfualftjdJ_eYkLfPvu5tZubYQ_Pn9oFYGCV_6yKy3KMGhWGUCyCdHaPhalBw",
    resolver: "MEMORY",
    "resolver_preload": {
      ACZSWBJ4SYILK7QVDELO64VX3EFWB6CXCPMEBUKA36MJJQRPXGEEQ2WJ:
        "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJXVFdYVDNCT1JWSFNLQkc2T0pIVVdFQ01QRVdBNldZVEhNRzVEWkJBUUo1TUtGU1dHM1FRIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInN1YiI6IkFDWlNXQko0U1lJTEs3UVZERUxPNjRWWDNFRldCNkNYQ1BNRUJVS0EzNk1KSlFSUFhHRUVRMldKIiwidHlwZSI6ImFjY291bnQiLCJuYXRzIjp7ImxpbWl0cyI6eyJzdWJzIjotMSwiY29ubiI6LTEsImltcG9ydHMiOi0xLCJleHBvcnRzIjotMSwiZGF0YSI6LTEsInBheWxvYWQiOi0xLCJ3aWxkY2FyZHMiOnRydWV9fX0.q-E7bBGTU0uoTmM9Vn7WaEHDzCUrqvPDb9mPMQbry_PNzVAjf0RG9vd15lGxW5lu7CuGVqpj4CYKhNDHluIJAg",
    },
  };
  const ns = await NatsServer.start(conf);
  let nc = await ns.connect(
    {
      authenticator: jwtAuthenticator(jwt, new TextEncoder().encode(useed)),
    },
  );
  await nc.flush();
  await nc.close();

  nc = await ns.connect(
    {
      authenticator: jwtAuthenticator((): string => {
        return jwt;
      }, new TextEncoder().encode(useed)),
    },
  );
  await nc.flush();
  await nc.close();

  await ns.stop();
});

Deno.test("auth - custom error", async () => {
  const ns = await NatsServer.start(conf);
  const authenticator = () => {
    throw new Error("user code exploded");
  };
  await assertRejects(
    () => {
      return ns.connect(
        {
          maxReconnectAttempts: 1,
          authenticator: authenticator,
        },
      );
    },
    Error,
    "user code exploded",
  );
  await ns.stop();
});

Deno.test("basics - bad auth", async () => {
  await assertRejects(
    () => {
      return connect(
        {
          servers: "connect.ngs.global",
          reconnect: false,
          user: "me",
          pass: "you",
        },
      );
    },
    errors.AuthorizationError,
    "Authorization Violation",
  );
});

Deno.test("auth - nkey authentication", async () => {
  const ukp = nkeys.createUser();
  const conf = {
    authorization: {
      users: [{
        nkey: ukp.getPublicKey(),
      }],
    },
  };

  // static
  const ns = await NatsServer.start(conf);
  let nc = await ns.connect({
    authenticator: nkeyAuthenticator(ukp.getSeed()),
  });
  await nc.flush();
  await nc.close();

  // from function
  nc = await ns.connect({
    authenticator: nkeyAuthenticator((): Uint8Array => {
      return ukp.getSeed();
    }),
  });
  await nc.flush();
  await nc.close();
  await ns.stop();
});

Deno.test("auth - creds authenticator validation", () => {
  const jwt =
    `eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJFU1VQS1NSNFhGR0pLN0FHUk5ZRjc0STVQNTZHMkFGWERYQ01CUUdHSklKUEVNUVhMSDJBIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJBQ1pTV0JKNFNZSUxLN1FWREVMTzY0VlgzRUZXQjZDWENQTUVCVUtBMzZNSkpRUlBYR0VFUTJXSiIsInN1YiI6IlVBSDQyVUc2UFY1NTJQNVNXTFdUQlAzSDNTNUJIQVZDTzJJRUtFWFVBTkpYUjc1SjYzUlE1V002IiwidHlwZSI6InVzZXIiLCJuYXRzIjp7InB1YiI6e30sInN1YiI6e319fQ.kCR9Erm9zzux4G6M-V2bp7wKMKgnSNqMBACX05nwePRWQa37aO_yObbhcJWFGYjo1Ix-oepOkoyVLxOJeuD8Bw`;
  const ukp = nkeys.createUser();
  const upk = ukp.getPublicKey();
  const seed = new TextDecoder().decode(ukp.getSeed());

  function creds(ajwt = "", aseed = ""): string {
    return `-----BEGIN NATS USER JWT-----
    ${ajwt}
  ------END NATS USER JWT------

************************* IMPORTANT *************************
  NKEY Seed printed below can be used sign and prove identity.
    NKEYs are sensitive and should be treated as secrets.

  -----BEGIN USER NKEY SEED-----
    ${aseed}
  ------END USER NKEY SEED------
 `;
  }

  type test = [string, string, boolean, string];
  const tests: test[] = [];
  tests.push(["", "", false, "no jwt, no seed"]);
  tests.push([jwt, "", false, "no seed"]);
  tests.push(["", seed, false, "no jwt"]);
  tests.push([jwt, seed, true, "jwt and seed"]);

  tests.forEach((v) => {
    const d = new TextEncoder().encode(creds(v[0], v[1]));
    try {
      const auth = credsAuthenticator(d);
      if (!v[2]) {
        fail(`should have failed: ${v[3]}`);
      }
      const { nkey, sig } = auth("helloworld") as unknown as NKeyAuth;
      assertEquals(nkey, upk);
      assert(sig.length > 0);
    } catch (_err) {
      if (v[2]) {
        fail(`should have passed: ${v[3]}`);
      }
    }
  });
});

Deno.test("auth - expiration is notified", async () => {
  const O = nkeys.createOperator();
  const A = nkeys.createAccount();

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

  const ns = await NatsServer.start(conf);

  const U = nkeys.createUser();
  const ujwt = await encodeUser("U", U, A, { bearer_token: true }, {
    exp: Math.round(Date.now() / 1000) + 5,
  });

  const nc = await ns.connect({
    reconnect: false,
    authenticator: jwtAuthenticator(ujwt),
  });

  let authErrors = 0;
  (async () => {
    for await (const s of nc.status()) {
      if (
        s.type === "error" &&
        s.error instanceof errors.UserAuthenticationExpiredError
      ) {
        authErrors++;
      }
    }
  })().then();

  const err = await nc.closed();
  assert(authErrors >= 1);
  assertExists(err);
  assert(err instanceof errors.UserAuthenticationExpiredError, err?.message);
  await cleanup(ns);
});

Deno.test("auth - expiration is notified and recovered", async () => {
  const O = nkeys.createOperator();
  const A = nkeys.createAccount();

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

  const ns = await NatsServer.start(conf);

  const U = nkeys.createUser();
  let ujwt = await encodeUser("U", U, A, { bearer_token: true }, {
    exp: Math.round(Date.now() / 1000) + 3,
  });

  const timer = setInterval(() => {
    encodeUser("U", U, A, { bearer_token: true }, {
      exp: Math.round(Date.now() / 1000) + 3,
    }).then((token) => {
      ujwt = token;
    });
  }, 250);

  const nc = await ns.connect({
    maxReconnectAttempts: -1,
    authenticator: jwtAuthenticator(() => {
      return ujwt;
    }),
  });

  const d = deferred();
  let reconnects = 0;
  let authErrors = 0;
  (async () => {
    for await (const s of nc.status()) {
      switch (s.type) {
        case "reconnect":
          reconnects++;
          if (reconnects === 4) {
            d.resolve();
          }
          break;
        case "error":
          if (s.error instanceof errors.UserAuthenticationExpiredError) {
            authErrors++;
          }
          break;
        default:
          // ignored
      }
    }
  })().then();

  await d;
  clearInterval(timer);
  assert(authErrors >= 1);
  assert(reconnects >= 4);
  await cleanup(ns, nc);
});

Deno.test("auth - bad auth is notified", async () => {
  const ns = await NatsServer.start(conf);

  let count = 0;

  // authenticator that works once
  const authenticator = (): UserPass => {
    const pass = count === 0 ? "foobar" : "bad";
    count++;
    return { user: "derek", pass };
  };

  const nc = await ns.connect(
    { authenticator },
  );
  let badAuths = 0;
  (async () => {
    for await (const s of nc.status()) {
      if (
        s.type === "error" && s.error instanceof errors.AuthorizationError
      ) {
        badAuths++;
      }
    }
  })().then();

  await nc.reconnect();

  const err = await nc.closed();
  assert(badAuths > 1);
  assert(err instanceof errors.AuthorizationError);

  await ns.stop();
});

Deno.test("auth - perm request error", async () => {
  const ns = await NatsServer.start({
    authorization: {
      users: [{
        user: "a",
        password: "b",
        permission: {
          publish: "r",
        },
      }, {
        user: "s",
        password: "s",
        permission: {
          subscribe: "q",
        },
      }],
    },
  });

  const [nc, sc] = await Promise.all([
    ns.connect(
      { user: "a", pass: "b" },
    ),
    ns.connect(
      { user: "s", pass: "s" },
    ),
  ]);

  sc.subscribe("q", {
    callback: (err, msg) => {
      if (err) {
        return;
      }
      msg.respond();
    },
  });

  const status = deferred<Status>();
  (async () => {
    for await (const s of nc.status()) {
      if (
        s.type === "error" && s.error instanceof errors.PermissionViolationError
      ) {
        if (s.error.operation === "publish" && s.error.subject === "q") {
          status.resolve(s);
        }
      }
    }
  })().then();

  assertRejects(() => {
    return nc.request("q");
  }, errors.RequestError);

  await status;
  await cleanup(ns, nc, sc);
});

Deno.test("auth - perm request error no mux", async () => {
  const ns = await NatsServer.start({
    authorization: {
      users: [{
        user: "a",
        password: "b",
        permission: {
          publish: "r",
        },
      }, {
        user: "s",
        password: "s",
        permission: {
          subscribe: "q",
        },
      }],
    },
  });

  const [nc, sc] = await Promise.all([
    ns.connect(
      { user: "a", pass: "b" },
    ),
    ns.connect(
      { user: "s", pass: "s" },
    ),
  ]);

  sc.subscribe("q", {
    callback: (err, msg) => {
      if (err) {
        return;
      }
      msg.respond();
    },
  });

  const status = deferred<Status>();
  (async () => {
    for await (const s of nc.status()) {
      if (
        s.type === "error" && s.error instanceof errors.PermissionViolationError
      ) {
        if (s.error.operation === "publish" && s.error.subject === "q") {
          status.resolve(s);
        }
      }
    }
  })().then();

  await assertRejects(
    () => {
      return nc.request("q", Empty, { noMux: true, timeout: 1000 });
    },
    errors.RequestError,
    "q",
  );

  await cleanup(ns, nc, sc);
});

Deno.test("auth - perm request error deliver to sub", async () => {
  const ns = await NatsServer.start({
    authorization: {
      users: [{
        user: "a",
        password: "b",
        permission: {
          publish: "r",
        },
      }, {
        user: "s",
        password: "s",
        permission: {
          subscribe: "q",
        },
      }],
    },
  });

  const [nc, sc] = await Promise.all([
    ns.connect(
      { user: "a", pass: "b" },
    ),
    ns.connect(
      { user: "s", pass: "s" },
    ),
  ]);

  sc.subscribe("q", {
    callback: (err, msg) => {
      if (err) {
        return;
      }
      msg.respond();
    },
  });

  const status = deferred<Status>();
  (async () => {
    for await (const s of nc.status()) {
      if (
        s.type === "error" && s.error instanceof errors.PermissionViolationError
      ) {
        if (s.error.subject === "q" && s.error.operation === "publish") {
          status.resolve();
        }
      }
    }
  })().then();

  const inbox = createInbox();
  const sub = nc.subscribe(inbox, {
    callback: () => {
    },
  });

  await assertRejects(
    () => {
      return nc.request("q", Empty, {
        noMux: true,
        reply: inbox,
        timeout: 1000,
      });
    },
    errors.RequestError,
    `Permissions Violation for Publish to "q"`,
  );

  assertEquals(sub.isClosed(), false);

  await cleanup(ns, nc, sc);
});

Deno.test("auth - mux request perms", async () => {
  const conf = {
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permission: {
          subscribe: "q.>",
        },
      }],
    },
  };
  const ns = await NatsServer.start(conf);
  const nc = await ns.connect({ user: "a", pass: "a" });
  await assertRejects(
    () => {
      return nc.request("q");
    },
    errors.RequestError,
    "Permissions Violation for Subscription",
  );

  const nc2 = await ns.connect({ user: "a", pass: "a", inboxPrefix: "q" });
  await assertRejects(
    () => {
      return nc2.request("q");
    },
    errors.RequestError,
    "no responders: 'q'",
  );

  await cleanup(ns, nc, nc2);
});

Deno.test("auth - perm sub iterator error", async () => {
  const ns = await NatsServer.start({
    authorization: {
      users: [{
        user: "a",
        password: "b",
        permission: {
          subscribe: "s",
        },
      }],
    },
  });

  const nc = await ns.connect({ user: "a", pass: "b" });

  const status = deferred<Status>();
  (async () => {
    for await (const s of nc.status()) {
      if (
        s.type === "error" && s.error instanceof errors.PermissionViolationError
      ) {
        if (s.error.subject === "q" && s.error.operation === "publish") {
          status.resolve(s);
        }
      }
    }
  })().then();

  const sub = nc.subscribe("q");
  await assertRejects(
    async () => {
      for await (const _m of sub) {
        // ignored
      }
    },
    errors.PermissionViolationError,
    `Permissions Violation for Subscription to "q"`,
  );

  await cleanup(ns, nc);
});

Deno.test("auth - perm error is not in lastError", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permission: {
          subscribe: {
            deny: "q",
          },
        },
      }],
    },
  }, { user: "a", pass: "a" });

  const nci = nc as NatsConnectionImpl;
  assertEquals(nci.protocol.lastError, undefined);

  const d = deferred<Error | null>();
  nc.subscribe("q", {
    callback: (err) => {
      d.resolve(err);
    },
  });

  const err = await d;
  assert(err !== null);
  assert(err instanceof errors.PermissionViolationError);
  assert(nci.protocol.lastError === undefined);

  await cleanup(ns, nc);
});

Deno.test("auth - ignore auth error abort", async () => {
  const ns = await NatsServer.start({
    authorization: {
      users: [{
        user: "a",
        password: "a",
      }],
    },
  });
  async function t(ignoreAuthErrorAbort = false): Promise<number> {
    let pass = "a";
    const authenticator = (): UserPass => {
      return { user: "a", pass };
    };
    const nc = await ns.connect({
      authenticator,
      ignoreAuthErrorAbort,
      reconnectTimeWait: 150,
    });

    let count = 0;
    (async () => {
      for await (const s of nc.status()) {
        if (
          s.type === "error" && s.error instanceof errors.AuthorizationError
        ) {
          count++;
        }
      }
    })().then();

    const nci = nc as NatsConnectionImpl;
    pass = "b";
    nci.protocol.transport.disconnect();

    await nc.closed();
    return count;
  }

  assertEquals(await t(), 2);
  assertEquals(await t(true), DEFAULT_MAX_RECONNECT_ATTEMPTS);
  await ns.stop();
});

Deno.test("auth - sub with permission error discards", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permission: {
          subscribe: {
            deny: "q",
          },
        },
      }],
    },
  }, { user: "a", pass: "a" });

  const nci = nc as NatsConnectionImpl;

  let count = 0;
  async function q() {
    count++;
    const d = deferred();
    const sub = nc.subscribe("q", {
      callback: (err) => {
        d.resolve(err);
      },
    });

    const err = await d;
    assert(err);
    assertEquals(nc.isClosed(), false);
    await sub.closed;

    const s = nci.protocol.subscriptions.get(count);
    assertEquals(s, undefined);
  }

  await q();
  await q();

  await cleanup(ns, nc);
});

Deno.test("auth - creds and un and pw and token", async () => {
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
    "resolver_preload": {
      ACZSWBJ4SYILK7QVDELO64VX3EFWB6CXCPMEBUKA36MJJQRPXGEEQ2WJ:
        "eyJ0eXAiOiJqd3QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJXVFdYVDNCT1JWSFNLQkc2T0pIVVdFQ01QRVdBNldZVEhNRzVEWkJBUUo1TUtGU1dHM1FRIiwiaWF0IjoxNTQ0MjE3NzU3LCJpc3MiOiJPQ0FUMzNNVFZVMlZVT0lNR05HVU5YSjY2QUgyUkxTREFGM01VQkNZQVk1UU1JTDY1TlFNNlhRRyIsInN1YiI6IkFDWlNXQko0U1lJTEs3UVZERUxPNjRWWDNFRldCNkNYQ1BNRUJVS0EzNk1KSlFSUFhHRUVRMldKIiwidHlwZSI6ImFjY291bnQiLCJuYXRzIjp7ImxpbWl0cyI6eyJzdWJzIjotMSwiY29ubiI6LTEsImltcG9ydHMiOi0xLCJleHBvcnRzIjotMSwiZGF0YSI6LTEsInBheWxvYWQiOi0xLCJ3aWxkY2FyZHMiOnRydWV9fX0.q-E7bBGTU0uoTmM9Vn7WaEHDzCUrqvPDb9mPMQbry_PNzVAjf0RG9vd15lGxW5lu7CuGVqpj4CYKhNDHluIJAg",
    },
  };
  const ns = await NatsServer.start(conf);
  const te = new TextEncoder();
  const nc = await ns.connect(
    {
      authenticator: [
        credsAuthenticator(te.encode(creds)),
        nkeyAuthenticator(
          te.encode(
            "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4",
          ),
        ),
      ],
      user: "a",
      pass: "secret",
      token: "mytoken",
    },
  );
  await nc.flush();
  await nc.close();
  await ns.stop();
});

Deno.test("auth - request context", async () => {
  const { ns, nc } = await setup({
    accounts: {
      S: {
        users: [{
          user: "s",
          password: "s",
          permission: {
            subscribe: ["q.>", "_INBOX.>"],
            publish: "$SYS.REQ.USER.INFO",
            allow_responses: true,
          },
        }],
        exports: [
          { service: "q.>" },
        ],
      },
      A: {
        users: [{ user: "a", password: "a" }],
        imports: [
          { service: { subject: "q.>", account: "S" } },
        ],
      },
    },
  }, { user: "s", pass: "s" });

  const srv = await (nc as NatsConnectionImpl).context();
  assertEquals(srv.data.user, "s");
  assertEquals(srv.data.account, "S");
  assertArrayIncludes(srv.data.permissions?.publish?.allow || [], [
    "$SYS.REQ.USER.INFO",
  ]);
  assertArrayIncludes(srv.data.permissions?.subscribe?.allow || [], [
    "q.>",
    "_INBOX.>",
  ]);
  assertEquals(srv.data.permissions?.responses?.max, 1);

  nc.subscribe("q.>", {
    callback(err, msg) {
      if (err) {
        fail(err.message);
      }
      const info = (msg as MsgImpl).requestInfo();
      assertEquals(info?.acc, "A");
      msg.respond();
    },
  });

  const a = await ns.connect({ user: "a", pass: "a" });
  await a.request("q.hello");

  await cleanup(ns, nc, a);
});

Deno.test("auth - sub queue permission", async () => {
  const conf = {
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permissions: { subscribe: ["q A"] },
      }],
    },
  };

  const { ns, nc } = await setup(conf, { user: "a", pass: "a" });

  const qA = deferred();
  nc.subscribe("q", {
    queue: "A",
    callback: (err, _msg) => {
      if (err) {
        qA.reject(err);
      }
    },
  });

  const qBad = deferred<Error>();
  nc.subscribe("q", {
    queue: "bad",
    callback: (err, _msg) => {
      if (err) {
        qBad.resolve(err);
      }
    },
  });
  await nc.flush();

  const err = await qBad;
  qA.resolve();

  await qA;

  assert(err instanceof errors.PermissionViolationError);
  assertStringIncludes(err.message, 'using queue "bad"');
  await cleanup(ns, nc);
});

Deno.test("auth - account expired", async () => {
  const O = nkeys.createOperator();
  const A = nkeys.createAccount();

  const resolver: Record<string, string> = {};
  resolver[A.getPublicKey()] = await encodeAccount("A", A, {
    limits: {
      conn: -1,
      subs: -1,
    },
  }, { signer: O, exp: Math.round(Date.now() / 1000) + 3 });

  const conf = {
    operator: await encodeOperator("O", O),
    resolver: "MEMORY",
    "resolver_preload": resolver,
  };

  const U = nkeys.createUser();
  const ujwt = await encodeUser("U", U, A, { bearer_token: true });

  const { ns, nc } = await setup(conf, {
    reconnect: false,
    authenticator: jwtAuthenticator(ujwt),
  });

  const d = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (
        s.type === "error" &&
        s.error.message.includes("account authentication expired")
      ) {
        d.resolve();
        break;
      }
    }
  })().catch(() => {});

  const w = await nc.closed();
  assertExists(w);
  assert(w instanceof errors.AuthorizationError);
  assertEquals(w.message, "Account Authentication Expired");

  await cleanup(ns, nc);
});

Deno.test("env conn", async () => {
  const ns = await NatsServer.start();
  const nc = await ns.connect({ debug: true });
  await nc.flush();
  await cleanup(ns, nc);
});
