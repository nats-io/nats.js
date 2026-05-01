/*
 * Copyright 2018-2021 The NATS Authors
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

import { connect } from "./connect.ts";
import { Lock, NatsServer } from "nst";
import type { NatsConnectionImpl } from "../src/internal_mod.ts";

Deno.test("disconnect - close handler is called on close", async () => {
  const ns = await NatsServer.start();
  const lock = Lock(1);
  const nc = await connect(
    { port: ns.port, reconnect: false },
  );
  nc.closed().then(() => {
    lock.unlock();
  });

  await ns.stop();
  await lock;
});

Deno.test("disconnect - close process inbound ignores", async () => {
  const ns = await NatsServer.start();
  const lock = Lock(1);
  const nc = await connect(
    { port: ns.port, reconnect: false },
  ) as NatsConnectionImpl;
  nc.closed().then(() => {
    lock.unlock();
  });

  await ns.stop();
  await lock;
});
