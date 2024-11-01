/*
 * Copyright 2020-2024 The NATS Authors
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
const { describe, it } = require("node:test");
const assert = require("node:assert").strict;
const {
  connect,
} = require(
  "../index",
);
const process = require("node:process");
const { resolve, join } = require("node:path");
const { readFileSync } = require("node:fs");
const { Lock } = require("./helpers/lock");
const { NatsServer } = require("./helpers/launcher");
const { buildAuthenticator, extend, Connect } = require(
  "@nats-io/nats-core/internal",
);

const dir = process.cwd();
const tlsConfig = {
  host: "0.0.0.0",
  tls: {
    cert_file: resolve(join(dir, "./tests/certs/server.pem")),
    key_file: resolve(join(dir, "./tests/certs/key.pem")),
    ca_file: resolve(join(dir, "./tests/certs/ca.pem")),
  },
};
describe("tls", { timeout: 20_000, concurrency: true, forceExit: true }, () => {
  it("fail if server doesn't support TLS", async () => {
    const ns = await NatsServer.start({ host: "0.0.0.0" });
    const lock = Lock();
    await connect({ servers: `localhost:${ns.port}`, tls: {} })
      .then(() => {
        assert.fail("shouldn't have connected");
      })
      .catch((err) => {
        assert.equal(err.message, "server does not support 'tls'");
        lock.unlock();
      });
    await lock;
    await ns.stop();
  });

  it("connects to tls without option", async () => {
    const nc = await connect({ servers: "demo.nats.io:4443" });
    await nc.flush();
    await nc.close();
  });

  it("custom ca fails without proper ca", async () => {
    const ns = await NatsServer.start(tlsConfig);
    const lock = Lock();
    await connect({ servers: `localhost:${ns.port}`, maxReconnectAttempts: 4 })
      .then(() => {
        assert.fail("shouldn't have connected without client ca");
      })
      .catch(() => {
        // this throws a totally un-useful connection reset.

        lock.unlock();
      });

    await lock;
    await ns.stop();
  });

  it("connects with proper ca", async () => {
    const ns = await NatsServer.start(tlsConfig);
    const nc = await connect({
      servers: `localhost:${ns.port}`,
      tls: {
        caFile: tlsConfig.tls.ca_file,
      },
    });
    await nc.flush();
    assert.ok(nc.protocol.transport.socket.authorized);
    await nc.close();
    await ns.stop();
  });

  it("connects with rejectUnauthorized is honored", async () => {
    const ns = await NatsServer.start(tlsConfig);
    const nc = await connect({
      servers: `localhost:${ns.port}`,
      tls: {
        rejectUnauthorized: false,
      },
    });
    await nc.flush();
    assert.ok(!nc.protocol.transport.socket.authorized);
    await nc.close();
    await ns.stop();
  });

  it("client auth", async () => {
    const ns = await NatsServer.start(tlsConfig);

    const certs = {
      keyFile: resolve(join(dir, "./tests/certs/client-key.pem")),
      certFile: resolve(join(dir, "./tests/certs/client-cert.pem")),
      caFile: resolve(join(dir, "./tests/certs/ca.pem")),
    };
    const nc = await connect({
      port: ns.port,
      tls: certs,
    });

    await nc.flush();
    await nc.close();
    await ns.stop();
  });

  it("client auth direct", async () => {
    const ns = await NatsServer.start(tlsConfig);

    const certs = {
      key: readFileSync(resolve(join(dir, "./tests/certs/client-key.pem"))),
      cert: readFileSync(resolve(join(dir, "./tests/certs/client-cert.pem"))),
      ca: readFileSync(resolve(join(dir, "./tests/certs/ca.pem"))),
    };
    const nc = await connect({
      port: ns.port,
      tls: certs,
    });

    await nc.flush();
    await nc.close();
    await ns.stop();
  });

  it("bad file paths", async () => {
    const ns = await NatsServer.start(tlsConfig);
    const certs = {
      keyFile: "./tests/certs/client-key.pem",
      certFile: "./x/certs/client-cert.pem",
      caFile: "./tests/certs/ca.pem",
    };
    try {
      await connect({
        port: ns.port,
        tls: certs,
      });
      assert.fail("should have not connected");
    } catch (err) {
      assert.ok(
        err.message.indexOf("/x/certs/client-cert.pem doesn't exist") > -1,
      );
    }

    await ns.stop();
  });

  it("shouldn't leak tls config", () => {
    const tlsOptions = {
      keyFile: resolve(join(dir, "./tests/certs/client-key.pem")),
      certFile: resolve(join(dir, "./tests/certs/client-cert.pem")),
      caFile: resolve(join(dir, "./tests/certs/ca.pem")),
    };

    let opts = { tls: tlsOptions, cert: "another" };
    const auth = buildAuthenticator(opts);
    opts = extend(opts, auth);

    const c = new Connect({ version: "1.2.3", lang: "test" }, opts);
    const cc = JSON.parse(JSON.stringify(c));
    assert.equal(cc.tls_required, true);
    assert.equal(cc.cert, undefined);
    assert.equal(cc.keyFile, undefined);
    assert.equal(cc.certFile, undefined);
    assert.equal(cc.caFile, undefined);
    assert.equal(cc.tls, undefined);
  });

  async function tlsInvalidCertMacro(conf, _tlsCode, re) {
    const ns = await NatsServer.start(tlsConfig);
    await assert.rejects(() => {
      return connect({ servers: `localhost:${ns.port}`, tls: conf });
    }, (err) => {
      assert.ok(re.exec(err.message));
      return true;
    });
    await ns.stop();
  }

  it(
    "invalid cert",
    () => {
      return tlsInvalidCertMacro(
        {
          keyFile: resolve(join(dir, "./tests/certs/client-key.pem")),
          certFile: resolve(join(dir, "./tests/certs/ca.pem")),
          caFile: resolve(join(dir, "./tests/certs/server.pem")),
        },
        "ERR_OSSL_X509_KEY_VALUES_MISMATCH",
        /key values mismatch/i,
      );
    },
  );

  it(
    "invalid pem no start",
    () => {
      return tlsInvalidCertMacro(
        {
          keyFile: resolve(join(dir, "./tests/certs/client-cert.pem")),
          certFile: resolve(join(dir, "./tests/certs/client-key.pem")),
          caFile: resolve(join(dir, "./tests/certs/ca.pem")),
        },
        "ERR_OSSL_PEM_NO_START_LINE",
        /no start line/i,
      );
    },
  );

  async function tlsInvalidArgPathMacro(conf, arg) {
    const ns = await NatsServer.start(tlsConfig);
    try {
      await connect({ servers: `localhost:${ns.port}`, tls: conf });
      assert.fail("shouldn't have connected");
    } catch (err) {
      const v = conf[arg];
      assert.equal(err.message, `${v} doesn't exist`);
    }
    await ns.stop();
  }

  it("invalid key file", () => {
    return tlsInvalidArgPathMacro({
      keyFile: resolve(join(dir, "./tests/certs/client.ky")),
    }, "keyFile");
  });

  it("invalid cert file", () => {
    return tlsInvalidArgPathMacro({
      certFile: resolve(join(dir, "./tests/certs/client.cert")),
    }, "certFile");
  });

  it("invalid ca file", () => {
    return tlsInvalidArgPathMacro({
      caFile: resolve(join(dir, "./tests/certs/ca.cert")),
    }, "caFile");
  });

  it("available connects with or without", async () => {
    const conf = Object.assign({}, { allow_non_tls: true }, tlsConfig);
    const ns = await NatsServer.start(conf);

    // test will fail to connect because the certificate is
    // not trusted, but the upgrade process was attempted.
    try {
      await connect({
        servers: `localhost:${ns.port}`,
      });
      assert.fail("shouldn't have connected");
    } catch (err) {
      assert.equal(err.message, "unable to verify the first certificate");
    }

    // will upgrade to tls as tls is required
    const a = connect({
      servers: `localhost:${ns.port}`,
      tls: {
        caFile: resolve(join(dir, "./tests/certs/ca.pem")),
      },
    });
    // will NOT upgrade to tls
    const b = connect({
      servers: `localhost:${ns.port}`,
      tls: null,
    });
    const conns = await Promise.all([a, b]);
    await conns[0].flush();
    await conns[1].flush();

    assert.equal(conns[0].protocol.transport.isEncrypted(), true);
    assert.equal(conns[1].protocol.transport.isEncrypted(), false);

    await ns.stop();
  });

  it("tls first", async () => {
    const ns = await NatsServer.start({
      host: "0.0.0.0",
      tls: {
        handshake_first: true,
        cert_file: resolve(join(dir, "./tests/certs/server.pem")),
        key_file: resolve(join(dir, "./tests/certs/key.pem")),
        ca_file: resolve(join(dir, "./tests/certs/ca.pem")),
      },
    });

    const nc = await connect({
      port: ns.port,
      tls: {
        handshakeFirst: true,
        ca: readFileSync(resolve(join(dir, "./tests/certs/ca.pem"))),
      },
    });

    await nc.flush();
    await nc.close();
    await ns.stop();
  });
});
