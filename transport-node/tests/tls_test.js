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
  "@nats-io/transport-node",
);
const process = require("node:process");
const { resolve, join } = require("node:path");
const fs = require("node:fs");
const { readFileSync } = fs;
const net = require("node:net");
const { Buffer } = require("node:buffer");
const tls = require("node:tls");
const { Lock } = require("@nats-io/nst");
const { NatsServer } = require("@nats-io/nst");
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
      assert.ok(
        err.message.indexOf("unable to verify the first certificate") > -1,
      );
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
  it("tls first reject unauthorized", async () => {
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
        rejectUnauthorized: false,
      },
    });

    await nc.flush();
    await nc.close();
    await ns.stop();
  });
});

describe("tls upgrade", () => {
  it("reset while loading cert files rejects the connect", async () => {
    // hold the ca file read open so the reset lands before the upgrade
    const caFile = resolve(join(dir, "./tests/certs/ca.pem"));
    const readFile = fs.readFile;
    fs.readFile = (fn, ...args) => {
      const delay = fn === caFile ? 300 : 0;
      setTimeout(() => readFile(fn, ...args), delay);
    };
    const srv = net.createServer((s) => {
      s.write(
        'INFO {"server_id":"x","version":"2.11.0","proto":1,"max_payload":1048576,"tls_required":true}\r\n',
      );
      setTimeout(() => s.resetAndDestroy(), 50);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      await assert.rejects(
        connect({
          servers: `127.0.0.1:${srv.address().port}`,
          tls: { caFile },
          reconnect: false,
        }),
        /ECONNRESET/,
      );
    } finally {
      fs.readFile = readFile;
      srv.close();
    }
  });
});

// fake server that sends a plaintext INFO and records the first bytes
// the client writes back, then drops the connection.
function fakeServer(info) {
  let resolveFirst;
  const first = new Promise((r) => {
    resolveFirst = r;
  });
  const srv = net.createServer((s) => {
    s.on("error", () => {});
    s.once("data", (d) => {
      resolveFirst(Buffer.from(d));
      s.destroy();
    });
    s.once("close", () => resolveFirst(Buffer.alloc(0)));
    s.write(
      `INFO ${
        JSON.stringify(Object.assign({
          server_id: "fake",
          version: "2.10.0",
          proto: 1,
          max_payload: 1024 * 1024,
          host: "127.0.0.1",
        }, info))
      }\r\n`,
    );
  });
  return new Promise((r) => {
    srv.listen(0, "127.0.0.1", () => {
      r({
        port: srv.address().port,
        first,
        stop: () => new Promise((rr) => srv.close(() => rr())),
      });
    });
  });
}

async function firstBytes(info, opts) {
  const srv = await fakeServer(info);
  const p = connect(
    Object.assign({ servers: `127.0.0.1:${srv.port}`, reconnect: false }, opts),
  );
  const result = await p.then(
    (nc) => nc.close().then(() => ({ ok: true })),
    (err) => ({ ok: false, err }),
  );
  const d = await srv.first;
  await srv.stop();
  return { result, data: d };
}

function assertTlsAttempt(data) {
  assert.equal(data[0], 0x16, "expected a tls handshake record");
  assert.equal(data.toString("latin1").indexOf("CONNECT"), -1);
}

function assertPlainConnect(data) {
  assert.ok(data.toString("latin1").startsWith("CONNECT"));
}

describe(
  "tls option makes tls mandatory",
  { timeout: 20_000, concurrency: true, forceExit: true },
  () => {
    const caFile = resolve(join(dir, "./tests/certs/ca.pem"));
    const creds = { user: "u", pass: "p" };
    for (const v of [1, "true", {}]) {
      for (const tls of [{}, { caFile }]) {
        const tn = tls.caFile ? "{caFile}" : "{}";
        it(`tls_available=${JSON.stringify(v)} tls=${tn}`, async () => {
          const { result, data } = await firstBytes(
            { tls_available: v },
            Object.assign({ tls }, creds),
          );
          assert.equal(result.ok, false);
          assertTlsAttempt(data);
        });
      }
    }

    it("tls_required=false tls_available=1 tls={}", async () => {
      const { result, data } = await firstBytes(
        { tls_required: false, tls_available: 1 },
        Object.assign({ tls: {} }, creds),
      );
      assert.equal(result.ok, false);
      assertTlsAttempt(data);
    });

    it("tls={handshakeFirst:1} tls_available=1", async () => {
      const { result, data } = await firstBytes(
        { tls_available: 1 },
        Object.assign({ tls: { handshakeFirst: 1 } }, creds),
      );
      assert.equal(result.ok, false);
      assertTlsAttempt(data);
    });

    it("tls unset tls_required=1 upgrades", async () => {
      const { data } = await firstBytes({ tls_required: 1 }, creds);
      assertTlsAttempt(data);
    });

    it("tls_available=true tls={} upgrades", async () => {
      const { result, data } = await firstBytes(
        { tls_available: true },
        Object.assign({ tls: {} }, creds),
      );
      assert.equal(result.ok, false);
      assertTlsAttempt(data);
    });

    it("tls unset tls_available=true upgrades", async () => {
      const { data } = await firstBytes({ tls_available: true }, creds);
      assertTlsAttempt(data);
    });

    it("tls unset tls_available=1 unchanged", async () => {
      const { data } = await firstBytes({ tls_available: 1 }, creds);
      assertPlainConnect(data);
    });

    it("tls null tls_available=true unchanged", async () => {
      const { data } = await firstBytes(
        { tls_available: true },
        Object.assign({ tls: null }, creds),
      );
      assertPlainConnect(data);
    });
  },
);
describe(
  "tls upgrade",
  { timeout: 20_000, concurrency: true, forceExit: true },
  () => {
    const ca = readFileSync(resolve(join(dir, "./tests/certs/ca.pem")));

    it("ignores plaintext bytes after info", async () => {
      const extra = JSON.stringify({
        server_id: "X",
        server_name: "OTHER",
        version: "2.10.0",
        proto: 1,
        connect_urls: ["other.example.com:4222"],
      });
      const srv = await upgradeServer({
        tls: true,
        extra: () => `INFO ${extra}\r\nPING\r\n`,
      });
      const nc = await connect({
        servers: `127.0.0.1:${srv.port}`,
        tls: { ca },
      });
      await nc.flush();
      assert.equal(nc.info.server_name, "fake");
      const listens = nc.getServers().map((s) => s.listen);
      assert.ok(
        !listens.some((s) => s.includes("other.example.com")),
        `unexpected server in pool: ${listens}`,
      );
      assert.ok(nc.protocol.transport.isEncrypted());
      assert.ok(!srv.received.includes("PONG"), "client answered a ping");
      await nc.close();
      await srv.close();
    });

    // an injected INFO shows up in nc.getServers(), but an injected MSG can
    // only be seen by a subscription that would receive it (S21 delivered a
    // forged MSG). it has to be a reconnect: on the first connect the
    // subscription doesn't exist yet when the injected bytes are parsed, so
    // the MSG would be dropped with or without the fix. the server injects it
    // after the plaintext INFO of the reconnect, and only the MSG sent over
    // tls must be delivered.
    it("ignores plaintext msg after info on reconnect", async () => {
      const srv = await upgradeServer({
        tls: true,
        extra: (idx) => idx === 0 ? "" : "MSG foo 1 3\r\nbad\r\n",
        onLine: (line, sock, idx) => {
          if (idx > 0 && line.startsWith("SUB foo")) {
            sock.write("MSG foo 1 2\r\nok\r\n");
          }
        },
      });
      const nc = await connect({
        servers: `127.0.0.1:${srv.port}`,
        tls: { ca },
        reconnectTimeWait: 100,
      });
      const sub = nc.subscribe("foo", { max: 1 });
      await nc.flush();
      srv.sockets[0].destroy();
      for await (const m of sub) {
        assert.equal(m.string(), "ok");
      }
      assert.equal(srv.conns(), 2);
      await nc.close();
      await srv.close();
    });

    it("plain connection still processes pipelined data", async () => {
      const srv = await upgradeServer({ tls: false, extra: () => "PING\r\n" });
      const nc = await connect({ servers: `127.0.0.1:${srv.port}` });
      await nc.flush();
      assert.equal(nc.info.server_name, "fake");
      assert.ok(!nc.protocol.transport.isEncrypted());
      assert.ok(srv.received.includes("PONG"));
      await nc.close();
      await srv.close();
    });

    it("rejects non info first op", async () => {
      const srv = await upgradeServer({ tls: false, first: "PING\r\n" });
      await assert.rejects(
        connect({ servers: `127.0.0.1:${srv.port}`, reconnect: false }),
        /unexpected response from server/,
      );
      await srv.close();
    });

    // a server that sends a plaintext info asking for tls, then the given
    // bytes, and closes the connection - as a full nats-server does
    async function closingServer(after) {
      const info = JSON.stringify({
        server_id: "FAKE",
        version: "2.10.0",
        proto: 1,
        max_payload: 1048576,
        tls_required: true,
      });
      const srv = net.createServer((sock) => {
        sock.on("error", () => {});
        // read until the client closes, so the socket closes too
        sock.resume();
        sock.end(`INFO ${info}\r\n${after}`);
      });
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      return {
        port: srv.address().port,
        close: () => new Promise((r) => srv.close(() => r())),
      };
    }

    it("failed upgrade quotes the dropped line", async () => {
      const srv = await closingServer(
        "-ERR 'maximum connections exceeded'\r\n",
      );
      await assert.rejects(
        connect({
          servers: `127.0.0.1:${srv.port}`,
          tls: { ca },
          reconnect: false,
        }),
        (err) => {
          assert.ok(err.message.includes("(untrusted)"), err.message);
          assert.ok(
            err.message.endsWith(`"-ERR 'maximum connections exceeded'"`),
            err.message,
          );
          return true;
        },
      );
      await srv.close();
    });

    it("failed upgrade without dropped bytes keeps the error", async () => {
      const srv = await closingServer("");
      await assert.rejects(
        connect({
          servers: `127.0.0.1:${srv.port}`,
          tls: { ca },
          reconnect: false,
        }),
        (err) => {
          assert.ok(!err.message.includes("(untrusted)"), err.message);
          return true;
        },
      );
      await srv.close();
    });

    it("cleartext info doesn't replace the discovered servers", async () => {
      const info = (urls) =>
        `INFO ${
          JSON.stringify({
            server_id: "FAKE",
            server_name: "fake",
            version: "2.10.0",
            proto: 1,
            max_payload: 1048576,
            tls_required: true,
            connect_urls: urls,
          })
        }\r\n`;
      // connect_urls in the cleartext info are unauthenticated
      let sock;
      const srv = await upgradeServer({
        tls: true,
        first: info(["cleartext.example.com:4222"]),
        onLine: (_line, s) => {
          sock = s;
        },
      });
      const nc = await connect({
        servers: `127.0.0.1:${srv.port}`,
        tls: { ca },
      });
      await nc.flush();
      const listens = () => nc.getServers().map((s) => s.listen);
      assert.ok(
        !listens().some((s) => s.startsWith("cleartext.example.com")),
        `server from the cleartext info in pool: ${listens()}`,
      );
      // and they are cleared from the info the client keeps
      assert.equal(nc.info?.connect_urls, undefined);

      // an info received over tls is applied
      sock.write(info(["tls.example.com:4222"]));
      for (
        let i = 0;
        i < 40 && !listens().some((s) => s.startsWith("tls."));
        i++
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        listens().some((s) => s.startsWith("tls.example.com")),
        `server from the tls info missing: ${listens()}`,
      );
      await nc.close();
      await srv.close();
    });
  },
);

describe(
  "tls upgrade host verification",
  { timeout: 20_000, concurrency: true, forceExit: true },
  () => {
    const ca = readFileSync(resolve(join(dir, "./tests/certs/ca.pem")));
    // server_iponly.pem only has ip sans (127.0.0.1, ::1)

    it("ip server verifies against ip san", async () => {
      const srv = await upgradeServer({
        tls: true,
        cert: "server_iponly.pem",
        key: "key_iponly.pem",
      });
      const nc = await connect({
        servers: `127.0.0.1:${srv.port}`,
        tls: { ca },
        reconnect: false,
      });
      await nc.flush();
      assert.ok(nc.protocol.transport.isEncrypted());
      assert.ok(nc.protocol.transport.socket.authorized);
      await nc.close();
      await srv.close();
    });

    it("ip server rejects localhost only cert", async () => {
      const srv = await upgradeServer({
        tls: true,
        cert: "server_noip.pem",
        key: "key_noip.pem",
      });
      await assert.rejects(
        connect({
          servers: `127.0.0.1:${srv.port}`,
          tls: { ca },
          reconnect: false,
        }),
        (err) => {
          assert.equal(err.code, "ERR_TLS_CERT_ALTNAME_INVALID");
          assert.match(err.message, /IP: 127\.0\.0\.1/);
          return true;
        },
      );
      await srv.close();
    });

    it("localhost server verifies against dns san", async () => {
      const srv = await upgradeServer({
        tls: true,
        cert: "server_noip.pem",
        key: "key_noip.pem",
      });
      const nc = await connect({
        servers: `localhost:${srv.port}`,
        tls: { ca },
        reconnect: false,
      });
      await nc.flush();
      assert.ok(nc.protocol.transport.isEncrypted());
      assert.ok(nc.protocol.transport.socket.authorized);
      await nc.close();
      await srv.close();
    });
  },
);

// minimal nats server that sends a plaintext info, optionally followed
// by extra bytes, then optionally upgrades to tls
async function upgradeServer(opts) {
  const key = readFileSync(
    resolve(join(dir, `./tests/certs/${opts.key || "key.pem"}`)),
  );
  const cert = readFileSync(
    resolve(join(dir, `./tests/certs/${opts.cert || "server.pem"}`)),
  );
  const received = [];
  const sockets = [];
  let conns = 0;
  const srv = net.createServer((raw) => {
    const idx = conns++;
    raw.on("error", () => {});
    const info = {
      server_id: "FAKE",
      server_name: "fake",
      version: "2.10.0",
      proto: 1,
      max_payload: 1048576,
      headers: true,
    };
    if (opts.tls) {
      info.tls_required = true;
    }
    const extra = opts.extra ? opts.extra(idx) : "";
    raw.write(opts.first || `INFO ${JSON.stringify(info)}\r\n${extra}`);
    const sock = opts.tls
      ? new tls.TLSSocket(raw, { isServer: true, key, cert })
      : raw;
    sockets.push(sock);
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        received.push(line);
        if (line.startsWith("PING")) {
          sock.write("PONG\r\n");
        }
        if (opts.onLine) {
          opts.onLine(line, sock, idx);
        }
      }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    port: srv.address().port,
    received,
    sockets,
    conns: () => conns,
    close: () => {
      sockets.forEach((s) => s.destroy());
      return new Promise((r) => srv.close(() => r()));
    },
  };
}
