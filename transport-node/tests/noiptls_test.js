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
const {
  connect,
} = require(
  "../index",
);

const process = require("node:process");
const { resolve, join } = require("node:path");
const { Lock } = require("./helpers/lock");
const { NatsServer } = require("./helpers/launcher");

const dir = process.cwd();
const tlsConfig = {
  trace: true,
  tls: {
    ca_file: resolve(join(dir, "/tests/certs/ca.pem")),
    cert_file: resolve(join(dir, "/tests/certs/server_noip.pem")),
    key_file: resolve(join(dir, "/tests/certs/key_noip.pem")),
  },
};

describe("tls", { timeout: 20_000, concurrency: true, forceExit: true }, () => {
  it("reconnect via tls by ip", async () => {
    if (process.env.CI) {
      console.log("skipped test");
      return;
    }

    const servers = await NatsServer.startCluster(3, tlsConfig);
    const nc = await connect(
      {
        port: servers[0].port,
        reconnectTimeWait: 250,
        tls: {
          caFile: resolve(join(dir, "/tests/certs/ca.pem")),
        },
      },
    );

    await nc.flush();
    const lock = Lock();
    const iter = nc.status();
    (async () => {
      for await (const e of iter) {
        if (e.type === "reconnect") {
          lock.unlock();
        }
      }
    })().then();

    await servers[0].stop();
    await lock;
    await nc.close();
    await NatsServer.stopAll(servers);
  });
});
