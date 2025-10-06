import { join, resolve } from "@std/path";
import { cleanup, connect, NatsServer, wsServerConf } from "test_helpers";
import { delay, wsconnect } from "../src/internal_mod.ts";
import type { NatsConnectionImpl } from "../src/internal_mod.ts";
import { assertEquals } from "@std/assert";

Deno.test("tls-unsafe - handshake first", async () => {
  const cwd = Deno.cwd();
  const config = {
    trace: true,
    debug: true,
    host: "localhost",
    tls: {
      handshake_first: true,
      cert_file: resolve(
        join(cwd, "./core/tests/certs/localhost.crt"),
      ),
      key_file: resolve(
        join(cwd, "./core/tests/certs/localhost.key"),
      ),
      ca_file: resolve(join(cwd, "./core/tests/certs/RootCA.crt")),
    },
  };

  const ns = await NatsServer.start(config);
  console.log("port", ns.port);
  const nc = await connect({
    debug: true,
    servers: `localhost:${ns.port}`,
    tls: {
      handshakeFirst: true,
      caFile: config.tls.ca_file,
    },
  });
  nc.subscribe("foo", {
    callback(_err, msg) {
      msg.respond(msg.data);
    },
  });

  await nc.request("foo", "hello");
  await nc.close();
  await ns.stop();
});

Deno.test({
  name: "wss - wss connect default",
  ignore: Deno.env.get("CI") === "true", // Skip in CI - requires binding to privileged port 443
  async fn() {
    const tlsConfig = await NatsServer.tlsConfig();
    const tls = tlsConfig.tls;
    const ns = await NatsServer.start(
      wsServerConf(
        {
          websocket: {
            port: 443,
            tls,
          },
        },
      ),
      true,
    );
    await delay(2000);
    const nc = await wsconnect();
    assertEquals(
      (nc as NatsConnectionImpl).protocol.transport?.isEncrypted(),
      true,
    );
    await nc.flush();
    await cleanup(ns, nc);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
