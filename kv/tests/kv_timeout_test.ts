/*
 * Copyright 2026 The NATS Authors
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
import { assert, assertEquals } from "@std/assert";
import { jetstream, StorageType } from "@nats-io/jetstream";
import { cleanup, jetstreamServerConf, setup } from "nst";
import { Kvm } from "../src/mod.ts";

Deno.test("kv - bucket timeout applies to create, open, reads and writes", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const requests: { subject: string; timeout: number | undefined }[] = [];
  const request = nc.request.bind(nc);
  nc.request = (subject, data, opts) => {
    requests.push({ subject, timeout: opts?.timeout });
    return request(subject, data, opts);
  };
  const js = jetstream(nc, { timeout: 4_000 });
  const kvm = new Kvm(js);
  const options = js.getOptions();
  async function check<T>(fn: () => Promise<T>, timeout: number): Promise<T> {
    requests.length = 0;
    const result = await fn();
    assert(requests.length > 0);
    for (const r of requests) {
      assertEquals(r.timeout, timeout, r.subject);
    }
    return result;
  }
  try {
    for (const allow_direct of [false, true]) {
      const name = allow_direct ? "DIRECT" : "STANDARD";
      const kv = await check(
        () =>
          kvm.create(name, {
            timeout: 1_000,
            allow_direct,
            storage: StorageType.Memory,
          }),
        1_000,
      );
      const seq = await check(() => kv.put("key", "one"), 1_000);
      assertEquals((await check(() => kv.get("key"), 1_000))?.string(), "one");
      await check(() => kv.update("key", "two", seq, 2_000), 2_000);
      await check(() => kv.status(), 1_000);

      const opened = await kvm.open(name, { timeout: 6_000, allow_direct });
      assertEquals(
        (await check(() => opened.get("key"), 6_000))?.string(),
        "two",
      );
      await check(() => opened.put("key", "three"), 6_000);
      await check(() => opened.put("key", "four", { timeout: 2_000 }), 2_000);
      await check(() => opened.delete("key"), 6_000);
      await check(() => opened.purge("key"), 6_000);

      const inherited = await kvm.open(name, { allow_direct });
      await check(() => inherited.get("key"), 4_000);
      // 0 is the same as not setting it
      const zero = await kvm.open(name, { allow_direct, timeout: 0 });
      await check(() => zero.get("key"), 4_000);
      // Configuring one bucket must not change another or the shared client.
      await check(() => kv.get("key"), 1_000);
      assertEquals(js.getOptions(), options);
      await check(() => js.jetstreamManager(), 4_000);
    }
  } finally {
    nc.request = request;
    await cleanup(ns, nc);
  }
});

Deno.test("kv - bucket timeout preserves JetStream domain and API options", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({
    jetstream: { domain: "KVTIMEOUT" },
  }));
  // a server with a domain still answers $JS.API locally, so check that the
  // bucket's own client used the domain's prefix and the watcher prefix
  const requested: string[] = [];
  const subscribed: string[] = [];
  const request = nc.request.bind(nc);
  nc.request = (subject, data, opts) => {
    requested.push(subject);
    return request(subject, data, opts);
  };
  const subscribe = nc.subscribe.bind(nc);
  nc.subscribe = (subject, opts) => {
    subscribed.push(subject);
    return subscribe(subject, opts);
  };
  try {
    const js = jetstream(nc, {
      domain: "KVTIMEOUT",
      timeout: 4_000,
      checkAPI: false,
      watcherPrefix: "kv_watchers",
    });
    const kvm = new Kvm(js);
    const kv = await kvm.create("DOMAIN", {
      timeout: 1_000,
      storage: StorageType.Memory,
    });
    await kv.put("key", "value");
    const opened = await kvm.open("DOMAIN", { timeout: 6_000 });
    assertEquals((await opened.get("key"))?.string(), "value");
    const history = await opened.history();
    const entries = [];
    for await (const entry of history) {
      entries.push(entry.string());
    }
    assertEquals(entries, ["value"]);
    assertEquals(js.getOptions().timeout, 4_000);

    const api = requested.filter((s) => s.startsWith("$JS."));
    assert(api.length > 0);
    for (const s of api) {
      assert(s.startsWith("$JS.KVTIMEOUT.API."), s);
    }
    assert(subscribed.some((s) => s.startsWith("kv_watchers.")));
  } finally {
    nc.request = request;
    nc.subscribe = subscribe;
    await cleanup(ns, nc);
  }
});
