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
import { fail } from "jsr:@std/assert";
import { ErrorCode } from "../src/internal_mod.ts";
import { assertErrorCode, NatsServer } from "test_helpers";
import { connect } from "./connect.ts";

const conf = { authorization: { token: "tokenxxxx" } };

Deno.test("token - empty", async () => {
  const ns = await NatsServer.start(conf);
  try {
    const nc = await connect(
      { port: ns.port, reconnect: false },
    );
    nc.closed().then((err) => {
      console.table(err);
    });
    await nc.close();
    fail("should not have connected");
  } catch (err) {
    assertErrorCode(err as Error, ErrorCode.AuthorizationViolation);
  }
  await ns.stop();
});

Deno.test("token - bad", async () => {
  const ns = await NatsServer.start(conf);
  try {
    const nc = await connect(
      { port: ns.port, token: "bad" },
    );
    await nc.close();
    fail("should not have connected");
  } catch (err) {
    assertErrorCode(err as Error, ErrorCode.AuthorizationViolation);
  }
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
