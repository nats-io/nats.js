/*
 * Copyright 2021-2024 The NATS Authors
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
import { Lock, NatsServer, ServerSignals } from "test_helpers";
import { connect } from "./connect.ts";
import { assertEquals } from "jsr:@std/assert";
import { delay } from "../src/internal_mod.ts";
import type { NatsConnectionImpl } from "../src/internal_mod.ts";
import { setup } from "test_helpers";

Deno.test("events - close on close", async () => {
  const { ns, nc } = await setup();
  nc.close().then();
  const status = await nc.closed();
  await ns.stop();
  assertEquals(status, undefined);
});

Deno.test("events - disconnect and close", async () => {
  const lock = Lock(2);
  const { ns, nc } = await setup({}, { reconnect: false });
  (async () => {
    for await (const s of nc.status()) {
      switch (s.type) {
        case "disconnect":
          lock.unlock();
          break;
      }
    }
  })().then();
  nc.closed().then(() => {
    lock.unlock();
  });
  await ns.stop();
  await lock;

  const v = await nc.closed();
  assertEquals(v, undefined);
});

Deno.test("events - disreconnect", async () => {
  const cluster = await NatsServer.cluster();
  const nc = await connect(
    {
      servers: `${cluster[0].hostname}:${cluster[0].port}`,
      maxReconnectAttempts: 1,
      reconnectTimeWait: 0,
    },
  );
  const disconnect = Lock();
  const reconnect = Lock();

  (async () => {
    for await (const s of nc.status()) {
      switch (s.type) {
        case "disconnect":
          disconnect.unlock();
          break;
        case "reconnect":
          reconnect.unlock();
          break;
      }
    }
  })().then();

  await cluster[0].stop();
  await Promise.all([disconnect, reconnect]);
  await nc.close();
  await NatsServer.stopAll(cluster, true);
});

Deno.test("events - update", async () => {
  const cluster = await NatsServer.cluster(1);
  const nc = await connect(
    {
      servers: `127.0.0.1:${cluster[0].port}`,
    },
  );
  const lock = Lock(1, 5000);
  (async () => {
    for await (const s of nc.status()) {
      switch (s.type) {
        case "update": {
          assertEquals(s.added?.length, 1);
          lock.unlock();
          break;
        }
      }
    }
  })().then();
  await delay(250);
  const s = await NatsServer.addClusterMember(cluster[0]);
  cluster.push(s);
  await lock;
  await nc.close();
  await NatsServer.stopAll(cluster, true);
});

Deno.test("events - ldm", async () => {
  const cluster = await NatsServer.cluster(2);
  const nc = await connect(
    {
      servers: `127.0.0.1:${cluster[0].port}`,
    },
  );
  const lock = Lock(1, 5000);
  (async () => {
    for await (const s of nc.status()) {
      switch (s.type) {
        case "ldm":
          lock.unlock();
          break;
      }
    }
  })().then();

  await cluster[0].signal(ServerSignals.LDM);
  await lock;
  await nc.close();
  await NatsServer.stopAll(cluster, true);
});

Deno.test("events - ignore server updates", async () => {
  const cluster = await NatsServer.cluster(1);
  const nc = await connect(
    {
      servers: `127.0.0.1:${cluster[0].port}`,
      ignoreClusterUpdates: true,
    },
  ) as NatsConnectionImpl;
  assertEquals(nc.protocol.servers.length(), 1);
  const s = await NatsServer.addClusterMember(cluster[0]);
  cluster.push(s);
  await NatsServer.localClusterFormed(cluster);
  await nc.flush();
  assertEquals(nc.protocol.servers.length(), 1);
  await nc.close();
  await NatsServer.stopAll(cluster, true);
});
