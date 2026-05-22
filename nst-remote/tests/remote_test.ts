/*
 * Copyright 2020-2026 The NATS Authors
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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { connect } from "@nats-io/transport-deno";
import { registerConnect } from "@nats-io/nst";
import { closeRemoteContext, NatsServer } from "../src/mod.ts";

registerConnect(connect);

function gated(name: string, fn: () => Promise<void>): void {
  if (!Deno.env.get("NST_REMOTE_URL")) {
    Deno.test.ignore(name, fn);
    return;
  }
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

if (Deno.env.get("NST_REMOTE_URL")) {
  globalThis.addEventListener("unload", () => {
    closeRemoteContext();
  });
}

gated("nst-remote: start server, connect, stop", async () => {
  const ns = await NatsServer.start();
  try {
    const nc = await ns.connect();
    await nc.flush();
    await nc.close();
  } finally {
    await ns.stop(true);
  }
});

gated("nst-remote: cluster, connect each, varz, stopAll", async () => {
  const cluster = await NatsServer.cluster(3);
  try {
    assertEquals(cluster.length, 3);
    for (const s of cluster) {
      const nc = await s.connect();
      await nc.flush();
      await nc.close();
      const v = await s.varz() as { server_name?: string };
      assert(v && typeof v === "object", "varz returned an object");
    }
  } finally {
    await NatsServer.stopAll(cluster, true);
  }
});

gated("nst-remote: jetstreamCluster reports JS via jsz", async () => {
  const cluster = await NatsServer.jetstreamCluster(3);
  try {
    assertEquals(cluster.length, 3);
    const js = await cluster[0].jsz();
    assert(js, "jsz returned a response");
  } finally {
    await NatsServer.stopAll(cluster, true);
  }
});

gated("nst-remote: restart preserves name", async () => {
  const ns = await NatsServer.start();
  try {
    const before = ns.config.server_name;
    await ns.restart();
    assertEquals(ns.config.server_name, before);
  } finally {
    await ns.stop(true);
  }
});

gated("nst-remote: signal/reload/getLog/pid throw", async () => {
  const ns = await NatsServer.start();
  try {
    await assertRejects(() => ns.signal("SIGHUP"));
    await assertRejects(() => ns.reload({}));
    let threw = false;
    try {
      ns.getLog();
    } catch {
      threw = true;
    }
    assert(threw, "getLog throws");
    threw = false;
    try {
      ns.pid();
    } catch {
      threw = true;
    }
    assert(threw, "pid throws");
  } finally {
    await ns.stop(true);
  }
});
