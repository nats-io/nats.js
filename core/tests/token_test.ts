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
import { assertRejects } from "jsr:@std/assert";
import { NatsServer } from "test_helpers";
import { connect } from "./connect.ts";
import { errors } from "../src/errors.ts";

const conf = { authorization: { token: "tokenxxxx" } };

Deno.test("token - empty", async () => {
  const ns = await NatsServer.start(conf);
  await assertRejects(() => {
    return connect({ port: ns.port, reconnect: false, debug: true });
  }, errors.AuthorizationError);

  await ns.stop();
});

Deno.test("token - bad", async () => {
  const ns = await NatsServer.start(conf);
  await assertRejects(() => {
    return connect(
      { port: ns.port, token: "bad", reconnect: false },
    );
  }, errors.AuthorizationError);
  await ns.stop();
});

Deno.test("token - ok", async () => {
  const ns = await NatsServer.start(conf);
  const nc = await connect(
    { port: ns.port, token: "tokenxxxx" },
  );
  await nc.close();
  await ns.stop();
});
