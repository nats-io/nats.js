/*
 * Copyright 2020-2023 The NATS Authors
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
import { cleanup, NatsServer } from "nst";
import { deferred, type NatsConnection } from "../src/internal_mod.ts";
import { assertEquals } from "@std/assert";
import { connect } from "./connect.ts";

Deno.test("doublesubs - standard", async () => {
  let srv = await NatsServer.start({ trace: true });
  const connOpts = {
    servers: `localhost:${srv.port}`,
    reconnectTimeWait: 500,
    maxReconnectAttempts: -1,
    headers: true,
  };

  async function checkSubs(nc: NatsConnection, subs: string[]): Promise<void> {
    const connz = await srv.connz(nc.info?.client_id, true);
    const ci = connz.connections.find((c) => c.cid === nc.info?.client_id);
    assertEquals(ci?.subscriptions_list?.length, subs.length);
    assertEquals(ci?.subscriptions_list, subs);
  }

  const nc = await connect(connOpts);
  nc.subscribe("foo", { callback: () => {} });
  nc.subscribe("bar", { callback: () => {} });

  await nc.flush();
  await checkSubs(nc, ["foo", "bar"]);

  const disconnected = deferred<void>();
  const reconnected = deferred<void>();
  (async () => {
    for await (const e of nc.status()) {
      switch (e.type) {
        case "disconnect":
          disconnected.resolve();
          break;
        case "reconnect":
          reconnected.resolve();
          break;
      }
    }
  })().then();

  await srv.stop();
  await disconnected;

  nc.subscribe("baz", { callback: () => {} });

  srv = await srv.restart();
  await reconnected;
  await nc.flush();


  await checkSubs(nc, ["foo", "bar", "baz"]);
  await cleanup(srv, nc);
});
