import { jetstream, jetstreamManager } from "../src/jsclient.ts";
import { connect, flakyTest, NatsServer, notCompatible } from "test_helpers";
import {
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
} from "../src/jsapi_types.ts";
import type { StreamConfig, StreamUpdateConfig } from "../src/jsapi_types.ts";
import { nanos } from "@nats-io/nats-core/internal";

import {
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertRejects,
  fail,
} from "jsr:@std/assert";

Deno.test("jetstream - mirror alternates", async () => {
  const servers = await NatsServer.jetstreamCluster(3);
  const nc = await connect({ port: servers[0].port });
  if (await notCompatible(servers[0], nc, "2.8.2")) {
    await NatsServer.stopAll(servers, true);
    return;
  }

  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({ name: "src", subjects: ["A", "B"] });

  const nc1 = await connect({ port: servers[1].port });
  const jsm1 = await jetstreamManager(nc1);

  await jsm1.streams.add({
    name: "mirror",
    mirror: {
      name: "src",
    },
  });

  const n = await jsm1.streams.find("A");
  const si = await jsm1.streams.info(n);
  assertEquals(si.alternates?.length, 2);

  await nc.close();
  await nc1.close();
  await NatsServer.stopAll(servers, true);
});

Deno.test("jsm - stream update properties", async () => {
  const servers = await NatsServer.jetstreamCluster(3);
  const nc = await connect({ port: servers[0].port });

  const jsm = await jetstreamManager(nc, { timeout: 3000 });

  await jsm.streams.add({
    name: "a",
    storage: StorageType.File,
    subjects: ["x"],
  });

  let sn = "n";
  await jsm.streams.add({
    name: sn,
    storage: StorageType.File,
    subjects: ["subj"],
    duplicate_window: nanos(30 * 1000),
  });

  async function updateOption(
    opt: Partial<StreamUpdateConfig | StreamConfig>,
    shouldFail = false,
  ): Promise<void> {
    try {
      const si = await jsm.streams.update(sn, opt);
      for (const v of Object.keys(opt)) {
        const sc = si.config;
        //@ts-ignore: test
        assertEquals(sc[v], opt[v]);
      }
      if (shouldFail) {
        fail("expected to fail with update: " + JSON.stringify(opt));
      }
    } catch (err) {
      if (!shouldFail) {
        fail(err.message);
      }
    }
  }

  await updateOption({ name: "nn" }, true);
  await updateOption({ retention: RetentionPolicy.Interest }, true);
  await updateOption({ storage: StorageType.Memory }, true);
  await updateOption({ max_consumers: 5 }, true);

  await updateOption({ subjects: ["subj", "a"] });
  await updateOption({ description: "xx" });
  await updateOption({ max_msgs_per_subject: 5 });
  await updateOption({ max_msgs: 100 });
  await updateOption({ max_age: nanos(45 * 1000) });
  await updateOption({ max_bytes: 10240 });
  await updateOption({ max_msg_size: 10240 });
  await updateOption({ discard: DiscardPolicy.New });
  await updateOption({ no_ack: true });
  await updateOption({ duplicate_window: nanos(15 * 1000) });
  await updateOption({ allow_rollup_hdrs: true });
  await updateOption({ allow_rollup_hdrs: false });
  await updateOption({ num_replicas: 3 });
  await updateOption({ num_replicas: 1 });
  await updateOption({ deny_delete: true });
  await updateOption({ deny_purge: true });
  await updateOption({ sources: [{ name: "a" }] });
  await updateOption({ sealed: true });
  await updateOption({ sealed: false }, true);

  await jsm.streams.add({ name: "m", mirror: { name: "a" } });
  sn = "m";
  await updateOption({ mirror: { name: "nn" } }, true);

  await nc.close();
  await NatsServer.stopAll(servers, true);
});

Deno.test(
  "streams - mirrors",
  flakyTest(async () => {
    const cluster = await NatsServer.jetstreamCluster(3);
    const nc = await connect({ port: cluster[0].port });
    const jsm = await jetstreamManager(nc);

    // create a stream in a different server in the cluster
    await jsm.streams.add({
      name: "src",
      subjects: ["src.*"],
      placement: {
        cluster: cluster[1].config.cluster.name,
        tags: cluster[1].config.server_tags,
      },
    });

    // create a mirror in the server we connected
    await jsm.streams.add({
      name: "mirror",
      placement: {
        cluster: cluster[2].config.cluster.name,
        tags: cluster[2].config.server_tags,
      },
      mirror: {
        name: "src",
      },
    });

    const js = jetstream(nc);
    const s = await js.streams.get("src");
    assertExists(s);
    assertEquals(s.name, "src");

    const alternates = await s.alternates();
    assertEquals(2, alternates.length);
    assertArrayIncludes(alternates.map((a) => a.name), ["src", "mirror"]);

    await assertRejects(
      async () => {
        await js.streams.get("another");
      },
      Error,
      "stream not found",
    );

    const s2 = await s.best();
    const selected = (await s.info(true)).alternates?.[0]?.name ?? "";
    assertEquals(s2.name, selected);

    await nc.close();
    await NatsServer.stopAll(cluster, true);
  }),
);
