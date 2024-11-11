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
import { NatsServer } from "../../test_helpers/launcher.ts";

import { deferred, Empty, extend, headers } from "../src/internal_mod.ts";
import type { NatsConnectionImpl } from "../src/internal_mod.ts";
import { assertArrayIncludes, assertEquals } from "jsr:@std/assert";
import { connect } from "./connect.ts";

async function runDoubleSubsTest(tls: boolean) {
  const tlsConfig = await NatsServer.tlsConfig();

  let opts = { trace: true, host: "0.0.0.0" };

  if (tls) {
    opts = extend(opts, { tls: tlsConfig.tls });
  }

  let srv = await NatsServer.start(opts);

  let connOpts = {
    servers: `localhost:${srv.port}`,
    reconnectTimeWait: 500,
    maxReconnectAttempts: -1,
    headers: true,
  };

  const cert = {
    tls: {
      caFile: tlsConfig.tls.ca_file,
    },
  };
  if (tls) {
    connOpts = extend(connOpts, cert);
  }
  const nc = await connect(connOpts) as NatsConnectionImpl;

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

  await nc.flush();
  await srv.stop();
  await disconnected;

  const foo = nc.subscribe("foo");
  const bar = nc.subscribe("bar");
  const baz = nc.subscribe("baz");
  nc.publish("foo", Empty);
  nc.publish("bar", "hello");
  const h = headers();
  h.set("foo", "bar");
  nc.publish("baz", Empty, { headers: h });

  srv = await srv.restart();
  await reconnected;
  await nc.flush();

  // pubs are stripped
  assertEquals(foo.getReceived(), 0);
  assertEquals(bar.getReceived(), 0);
  assertEquals(baz.getReceived(), 0);

  await nc.close();
  await srv.stop();

  const log = srv.getLog();

  let count = 0;
  const subs: string[] = [];
  const sub = /\[SUB (\S+) \d]/;
  log.split("\n").forEach((s) => {
    const m = sub.exec(s);
    if (m) {
      count++;
      subs.push(m[1]);
    }
  });

  await Deno.remove(tlsConfig.certsDir, { recursive: true });

  assertEquals(count, 3);
  assertArrayIncludes(subs, ["foo", "bar", "baz"]);
}

Deno.test("doublesubs - standard", async () => {
  await runDoubleSubsTest(false);
});

Deno.test("doublesubs - tls", async () => {
  await runDoubleSubsTest(true);
});
