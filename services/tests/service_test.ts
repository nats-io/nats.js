/*
 * Copyright 2022-2024 The NATS Authors
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
import { cleanup, setup } from "nst";
import { ServiceImpl } from "../src/service.ts";
import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertInstanceOf,
  assertRejects,
  assertThrows,
  fail,
} from "@std/assert";

import {
  collect,
  createInbox,
  deadline,
  deferred,
  delay,
  errors,
} from "@nats-io/nats-core/internal";
import type {
  Msg,
  NatsConnection,
  NatsConnectionImpl,
  QueuedIterator,
  SubscriptionImpl,
} from "@nats-io/nats-core/internal";
import type {
  EndpointInfo,
  Service,
  ServiceConfig,
  ServiceIdentity,
  ServiceInfo,
  ServiceStats,
} from "../src/mod.ts";
import {
  ServiceError,
  ServiceErrorCodeHeader,
  ServiceErrorHeader,
  ServiceResponseType,
  ServiceVerb,
  Svcm,
} from "../src/mod.ts";

Deno.test("service - control subject", () => {
  const test = (verb: ServiceVerb) => {
    assertEquals(ServiceImpl.controlSubject(verb), `$SRV.${verb}`);
    assertEquals(ServiceImpl.controlSubject(verb, "NamE"), `$SRV.${verb}.NamE`);
    assertEquals(
      ServiceImpl.controlSubject(verb, "nAmE", "Id"),
      `$SRV.${verb}.nAmE.Id`,
    );
    assertEquals(
      ServiceImpl.controlSubject(verb, "nAMe", "iD", "hello.service"),
      `hello.service.${verb}.nAMe.iD`,
    );
  };
  [ServiceVerb.INFO, ServiceVerb.PING, ServiceVerb.STATS]
    .forEach((v) => {
      test(v);
    });
});

Deno.test("service - bad name", async () => {
  const { ns, nc } = await setup({}, {});
  const svc = new Svcm(nc);
  const t = async (name: string, msg: string) => {
    await assertRejects(
      async () => {
        await svc.add({
          name: name,
          version: "1.0.0",
        });
      },
      Error,
      msg,
    );
  };

  await t("/", "name cannot contain '/'");
  await t(" ", "name cannot contain ' '");
  await t(">", "name cannot contain '>'");
  await t("", "name required");
  await cleanup(ns, nc);
});

Deno.test("service - client", async () => {
  const { ns, nc } = await setup({}, {});
  const subj = createInbox();
  const svc = new Svcm(nc);

  const srv = await svc.add({
    name: "test",
    version: "1.0.0",
    description: "responds with hello",
  }) as ServiceImpl;
  srv.addEndpoint("hello", {
    handler: (_err, msg) => {
      msg?.respond("hello");
    },
    subject: subj,
  });

  await nc.request(subj);
  await nc.request(subj);

  const m = svc.client();

  function verifyIdentity(ids: ServiceIdentity[]) {
    assertEquals(ids.length, 1);
    const e = ids[0];
    assertEquals(e.id, srv.id);
    assertEquals(e.name, srv.name);
    assertEquals(e.version, srv.version);
  }

  function verifyPing(pings: ServiceIdentity[]) {
    verifyIdentity(pings);
    const ping = pings[0];
    assertEquals(ping.type, ServiceResponseType.PING);
    const r = ping as unknown as Record<string, unknown>;
    delete r.version;
    delete r.name;
    delete r.id;
    delete r.type;
    assertEquals(Object.keys(r).length, 0, JSON.stringify(r));
  }
  verifyPing(await collect(await m.ping()));
  verifyPing(await collect(await m.ping("test")));
  verifyPing(await collect(await m.ping("test", srv.id)));

  function verifyInfo(infos: ServiceInfo[]) {
    verifyIdentity(infos);
    const info = infos[0];
    assertEquals(info.type, ServiceResponseType.INFO);
    assertEquals(info.description, srv.description);
    assertEquals(info.endpoints.length, srv.endpoints().length);
    assertArrayIncludes(
      info.endpoints.map((e) => {
        return e.subject;
      }),
      srv.subjects,
    );
    const r = info as unknown as Record<string, unknown>;
    delete r.type;
    delete r.version;
    delete r.name;
    delete r.id;
    delete r.description;
    delete r.endpoints;
    assertEquals(Object.keys(r).length, 0, JSON.stringify(r));
  }

  // info
  verifyInfo(await collect(await m.info()));
  verifyInfo(await collect(await m.info("test")));
  verifyInfo(await collect(await m.info("test", srv.id)));

  function verifyStats(stats: ServiceStats[]) {
    verifyIdentity(stats);
    const stat = stats[0];
    assertEquals(stat.type, ServiceResponseType.STATS);
    assert(Date.parse(stat.started) > 0);
    const s = stat.endpoints?.[0]!;
    assertEquals(s.num_requests, 2);
    assertEquals(s.num_errors, 0);
    assertEquals(typeof s.processing_time, "number");
    assertEquals(typeof s.average_processing_time, "number");

    // assert(Date.parse(stat.started) - Date.now() > 0, JSON.stringify(stat));

    const r = stat as unknown as Record<string, unknown>;
    delete r.type;
    delete r.version;
    delete r.name;
    delete r.id;
    delete r.started;
    delete r.endpoints;
    assertEquals(Object.keys(r).length, 0, JSON.stringify(r));
  }

  verifyStats(await collect(await m.stats()));
  verifyStats(await collect(await m.stats("test")));
  verifyStats(await collect(await m.stats("test", srv.id)));

  await cleanup(ns, nc);
});

Deno.test("service - basics", async () => {
  const { ns, nc } = await setup({}, {});
  const svc = new Svcm(nc);
  const conf: ServiceConfig = {
    name: "test",
    version: "0.0.0",
  };
  const srvA = await svc.add(conf) as ServiceImpl;
  srvA.addEndpoint("foo", (_err: Error | null, msg: Msg) => {
    msg?.respond();
  });
  const srvB = await svc.add(conf) as ServiceImpl;
  srvB.addEndpoint("foo", (_err: Error | null, msg: Msg) => {
    msg?.respond();
  });

  const m = svc.client();
  const count = async (
    p: Promise<QueuedIterator<unknown>>,
  ): Promise<number> => {
    return (await collect(await p)).length;
  };

  assertEquals(await count(m.ping()), 2);
  assertEquals(await count(m.ping("test")), 2);
  assertEquals(await count(m.ping("test", srvA.id)), 1);
  await assertRejects(
    async () => {
      await collect(await m.ping("test", "c"));
    },
    errors.NoRespondersError,
  );

  assertEquals(await count(m.info()), 2);
  assertEquals(await count(m.info("test")), 2);
  assertEquals(await count(m.info("test", srvB.id)), 1);
  await assertRejects(
    async () => {
      await collect(await m.info("test", "c"));
    },
    errors.NoRespondersError,
  );

  assertEquals(await count(m.stats()), 2);
  assertEquals(await count(m.stats("test")), 2);
  assertEquals(await count(m.stats("test", srvB.id)), 1);
  await assertRejects(
    async () => {
      await collect(await m.stats("test", "c"));
    },
    errors.NoRespondersError,
  );

  await srvA.stop();
  await srvB.stop();

  await cleanup(ns, nc);
});

Deno.test("service - stop error", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permissions: {
          subscribe: {
            deny: "fail",
          },
        },
      }],
    },
  }, { user: "a", pass: "a" });

  const svc = new Svcm(nc);
  const service = await svc.add({
    name: "test",
    version: "2.0.0",
  });

  service.addEndpoint("fail", () => {
    if (err) {
      service.stop(err);
      return;
    }
    fail("shouldn't have subscribed");
  });

  const err = await service.stopped as Error;
  assertInstanceOf(err, errors.PermissionViolationError);

  await cleanup(ns, nc);
});

Deno.test("service - start error", async () => {
  const { ns, nc } = await setup({
    authorization: {
      users: [{
        user: "a",
        password: "a",
        permissions: {
          subscribe: {
            deny: "fail",
          },
        },
      }],
    },
  }, { user: "a", pass: "a" });

  const svc = new Svcm(nc);
  const service = await svc.add({
    name: "test",
    version: "2.0.0",
  });

  service.addEndpoint("fail", (_err, msg) => {
    msg?.respond();
  });

  const err = await service.stopped as Error;
  assertInstanceOf(err, errors.PermissionViolationError);

  await cleanup(ns, nc);
});

Deno.test("service - callback error", async () => {
  const { ns, nc } = await setup();
  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "test",
    version: "2.0.0",
  });

  srv.addEndpoint("fail", (err) => {
    if (err === null) {
      throw new Error("boom");
    }
  });

  const m = await nc.request("fail");
  assertEquals(m.headers?.get(ServiceErrorHeader), "boom");
  assertEquals(m.headers?.get(ServiceErrorCodeHeader), "500");

  await cleanup(ns, nc);
});

Deno.test("service - service error is headers", async () => {
  const { ns, nc } = await setup();
  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "test",
    version: "2.0.0",
  });
  srv.addEndpoint("fail", (): void => {
    // tossing service error should have the code/description
    throw new ServiceError(1210, "something");
  });

  const m = await nc.request("fail");
  assertEquals(m.headers?.get(ServiceErrorHeader), "something");
  assertEquals(m.headers?.get(ServiceErrorCodeHeader), "1210");

  await cleanup(ns, nc);
});

Deno.test("service - sub stop", async () => {
  const { ns, nc } = await setup();
  const svc = new Svcm(nc);
  const service = await svc.add({
    name: "test",
    version: "2.0.0",
  });
  service.addEndpoint("q", (_err, m) => {
    m.respond();
  });

  const nci = nc as NatsConnectionImpl;
  for (const s of nci.protocol.subscriptions.subs.values()) {
    if (s.subject === "q") {
      s.close();
      break;
    }
  }
  const err = await service.stopped as Error;
  assertEquals(err.message, "required subscription q stopped");

  await cleanup(ns, nc);
});

Deno.test("service - monitoring sub stop", async () => {
  const { ns, nc } = await setup();
  const svc = new Svcm(nc);
  const service = await svc.add({
    name: "test",
    version: "2.0.0",
  });
  service.addEndpoint("q", (_err, m) => {
    m.respond();
  });

  const nci = nc as NatsConnectionImpl;
  for (const s of nci.protocol.subscriptions.subs.values()) {
    if (s.subject === "$SRV.PING") {
      s.close();
      break;
    }
  }
  const err = await service.stopped as Error;
  assertEquals(err.message, "required subscription $SRV.PING stopped");

  await cleanup(ns, nc);
});

Deno.test("service - custom stats handler", async () => {
  const { ns, nc } = await setup();
  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "test",
    version: "2.0.0",
    statsHandler: (): Promise<unknown> => {
      return Promise.resolve({ hello: "world" });
    },
  });
  srv.addEndpoint("q", (_err, m) => {
    m.respond();
  });

  const m = svc.client();
  const stats = await collect(await m.stats());
  assertEquals(stats.length, 1);
  assertEquals(
    (stats[0].endpoints?.[0].data as Record<string, unknown>).hello,
    "world",
  );

  await cleanup(ns, nc);
});

Deno.test("service - bad stats handler", async () => {
  const { ns, nc } = await setup();

  const config = {
    name: "test",
    version: "2.0.0",
    // @ts-ignore: test
    statsHandler: "hello world",
  };

  const svc = new Svcm(nc);
  const srv = await svc.add(config as unknown as ServiceConfig);
  srv.addEndpoint("q", (_err, m) => {
    m.respond();
  });

  const m = svc.client();
  const stats = await collect(await m.stats());
  assertEquals(stats.length, 1);
  assertEquals(stats[0].endpoints?.[0].data, undefined);

  await cleanup(ns, nc);
});

Deno.test("service - stats handler error", async () => {
  const { ns, nc } = await setup();
  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "test",
    version: "2.0.0",
    statsHandler: (): Promise<unknown> => {
      throw new Error("bad stats handler");
    },
  });
  srv.addEndpoint("q", (_err, m) => {
    m.respond();
  });

  const m = svc.client();
  const stats = await collect(await m.stats());
  assertEquals(stats.length, 1);
  assertEquals(stats[0].endpoints?.length, 1);
  const s = stats[0].endpoints?.[0]!;
  assertEquals(s.data, undefined);
  assertEquals(s.last_error, "bad stats handler");
  assertEquals(s.num_errors, 1);

  await cleanup(ns, nc);
});

Deno.test("service - reset", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const service = await svc.add({
    name: "test",
    version: "2.0.0",
  }) as ServiceImpl;

  service.addEndpoint("q", (_err, m) => {
    m.respond();
  });

  await nc.request("q");
  await nc.request("q");

  service.handlers[0].stats.countError(new Error("hello"));

  const m = svc.client();
  let stats = await collect(await m.stats());
  assertEquals(stats[0].endpoints?.length, 1);
  assertEquals(stats.length, 1);
  let stat = stats[0].endpoints?.[0]!;
  assert(stat.processing_time >= 0);
  assert(stat.average_processing_time >= 0);
  assertEquals(stat.num_errors, 1);
  assertEquals(stat.last_error, "hello");

  service.reset();
  stats = await collect(await m.stats());
  assertEquals(stats.length, 1);
  assertEquals(stats[0].endpoints?.length, 1);
  stat = stats[0].endpoints?.[0]!;
  assertEquals(stat.num_requests, 0);
  assertEquals(stat.processing_time, 0);
  assertEquals(stat.average_processing_time, 0);
  assertEquals(stat.num_errors, 0);
  assertEquals(stat.last_error, "");

  await cleanup(ns, nc);
});

Deno.test("service - iter", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const service = await svc.add({
    name: "test",
    version: "2.0.0",
  }) as ServiceImpl;
  const iter = service.addEndpoint("q");
  (async () => {
    for await (const m of iter) {
      await delay(500);
      m.respond();
    }
  })().then();

  await nc.request("q");
  await nc.request("q");
  service.handlers[0].stats.countError(new Error("hello"));

  const m = svc.client();
  let stats = await collect(await m.stats());
  assertEquals(stats.length, 1);
  assertEquals(stats[0].endpoints?.length, 1);
  const stat = stats[0].endpoints?.[0]!;
  assert(stat.processing_time >= 0);
  assert(stat.average_processing_time >= 0);
  assertEquals(stat.num_errors, 1);
  assertEquals(stat.last_error, "hello");

  service.reset();
  stats = await collect(await m.stats());
  assertEquals(stats.length, 1);
  await cleanup(ns, nc);
});

Deno.test("service - iter closed", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const service = await svc.add({
    name: "test",
    version: "2.0.0",
  });
  const iter = service.addEndpoint("q");
  (async () => {
    for await (const m of iter) {
      m.respond();
      break;
    }
  })().then();

  await nc.request("q");
  const err = await service.stopped;
  assertEquals(err, null);

  await cleanup(ns, nc);
});

Deno.test("service - version must be semver", async () => {
  const { ns, nc } = await setup();
  const test = (v?: string): Promise<Service> => {
    const svc = new Svcm(nc);
    return svc.add({
      name: "test",
      version: v!,
    });
  };

  await assertRejects(
    async () => {
      await test();
    },
    Error,
    "'' is not a semver value",
  );

  await assertRejects(
    async () => {
      await test("a.b.c");
    },
    Error,
    "'a.b.c' is not a semver value",
  );

  const srv = await test("v1.2.3-hello") as ServiceImpl;
  const info = srv.info();
  assertEquals(info.id, srv.id);
  assertEquals(info.name, srv.name);
  assertEquals(info.version, "v1.2.3-hello");
  assertEquals(info.description, srv.description);
  assertEquals(info.endpoints.length, 0);

  await cleanup(ns, nc);
});

Deno.test("service - service errors", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "test",
    version: "2.0.0",
  });

  const iter = srv.addEndpoint("q");
  (async () => {
    for await (const m of iter) {
      m.data.length ? m.respond() : m.respondError(411, "data required");
    }
  })().then();

  let r = await nc.request("q");
  assertEquals(ServiceError.isServiceError(r), true);
  const serr = ServiceError.toServiceError(r);
  assertEquals(serr?.code, 411);
  assertEquals(serr?.message, "data required");

  r = await nc.request("q", new Uint8Array(1));
  assertEquals(ServiceError.isServiceError(r), false);
  assertEquals(ServiceError.toServiceError(r), null);
  await cleanup(ns, nc);
});

// Deno.test("service - cross platform service test", async () => {
//   const nc = await connect({ servers: "demo.nats.io" });
//   const name = `echo_${nuid.next()}`;
//
//   const conf: ServiceConfig = {
//     name,
//     version: "0.0.1",
//     statsHandler: (): Promise<unknown> => {
//       return Promise.resolve("hello world");
//     },
//     metadata: {
//       service: name,
//     },
//   };
//
//   const svc = new Svc(nc);
//   const srv = await svc.add(conf);
//   srv.addEndpoint("test", {
//     subject: createInbox(),
//     handler: (_err, m): void => {
//       if (m.data.length === 0) {
//         m.respondError(400, "need a string", JSON.stringify(""));
//       } else {
//         if (m.string() === "error") {
//           throw new Error("service asked to throw an error");
//         }
//         m.respond(m.data);
//       }
//     },
//     metadata: {
//       endpoint: "a",
//     },
//   });
//
//   // running from root?
//   const scheck = Deno.cwd().endsWith("nats.js")
//     ? "./services/tests/service-check.ts"
//     : "./tests/service-check.ts";
//
//   const args = [
//     "run",
//     "-A",
//     scheck,
//     "--name",
//     name,
//     "--server",
//     "demo.nats.io",
//   ];
//
//   const cmd = new Deno.Command(Deno.execPath(), {
//     args,
//     stderr: "piped",
//     stdout: "piped",
//   });
//   const { success, stderr, stdout } = await cmd.output();
//
//   if (!success) {
//     console.log(new TextDecoder().decode(stdout));
//     console.log(new TextDecoder().decode(stderr));
//     fail(new TextDecoder().decode(stderr));
//   }
//
//   await nc.close();
// });

Deno.test("service - stats name respects assigned name", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const test = await svc.add({
    name: "tEsT",
    // @ts-ignore: testing
    version: "0.0.1",
  });
  test.addEndpoint("q", (_err, msg) => {
    msg?.respond();
  });
  const stats = await test.stats();
  assertEquals(stats.name, "tEsT");
  const r = await nc.request(`$SRV.PING.tEsT`);
  const si = r.json<ServiceIdentity>();
  assertEquals(si.name, "tEsT");

  await cleanup(ns, nc);
});

Deno.test("service - multiple endpoints", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const ms = await svc.add({
    name: "multi",
    version: "0.0.1",
  });
  ms.addEndpoint("hey", (_err, m) => {
    m.respond("hi");
  });
  ms.addGroup("service").addEndpoint("echo", (_err, m) => {
    m.respond(m.data);
  });

  let r = await nc.request(`hey`);
  assertEquals(r.string(), "hi");
  r = await nc.request(`service.echo`, "yo!");
  assertEquals(r.string(), "yo!");

  r = await nc.request(`$SRV.STATS`);
  const stats = r.json<ServiceStats>();

  function t(name: string) {
    const v = stats.endpoints?.find((n) => {
      return n.name === name;
    });
    assertExists(v);
    assertEquals(v.num_requests, 1);
  }
  t("hey");
  t("echo");

  await cleanup(ns, nc);
});

Deno.test("service - multi cb/iterator", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
  });
  srv.addGroup("cb").addGroup("b").addGroup("c").addEndpoint(
    "test",
    (_err, msg) => {
      msg?.respond();
    },
  );
  await nc.request("cb.b.c.test");

  const iter = srv.addGroup("iter.b.c").addEndpoint("test");
  (async () => {
    for await (const m of iter) {
      m.respond();
    }
  })().then();
  await nc.request("iter.b.c.test");

  await cleanup(ns, nc);
});

Deno.test("service - group and endpoint names", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
  });

  const t = (group: string, endpoint: string, expect: string) => {
    assertThrows(
      () => {
        srv.addGroup(group).addEndpoint(endpoint);
      },
      Error,
      expect,
    );
  };
  t("", "", "endpoint name required");
  t("", "*", "endpoint name cannot contain '*'");
  t("", ">", "endpoint name cannot contain '>'");
  t("", " ", "endpoint name cannot contain ' '");
  t("", "hello.world", "endpoint name cannot contain '.'");
  t("a.>", "hello", "service group name cannot contain internal '>'");
  t(">", "hello", "service group name cannot contain internal '>'");
  await cleanup(ns, nc);
});

Deno.test("service - group subs", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
  });
  const t = (subject: string) => {
    const sub = (nc as NatsConnectionImpl).protocol.subscriptions.all().find(
      (s) => {
        return s.subject === subject;
      },
    );
    assertExists(sub);
  };
  srv.addGroup("").addEndpoint("root");
  t("root");
  srv.addGroup("a").addEndpoint("add");
  t("a.add");
  srv.addGroup("b").addEndpoint("add");
  t("b.add");
  srv.addGroup("one.*.three").addEndpoint("add");
  t("one.*.three.add");
  srv.addGroup("$SYS.SOMETHING.OR.OTHER").addEndpoint("wild", { subject: "*" });
  t("$SYS.SOMETHING.OR.OTHER.*");
  await cleanup(ns, nc);
});

Deno.test("service - metadata", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: { service: "1" },
  });
  srv.addGroup("group").addEndpoint("endpoint", {
    handler: (_err, msg) => {
      msg.respond();
    },
    metadata: {
      endpoint: "endpoint",
    },
  });

  const info = srv.info();
  assertEquals(info.metadata, { service: "1" });
  const stats = await srv.stats();
  assertEquals(stats.endpoints?.length, 1);

  await cleanup(ns, nc);
});

Deno.test("service - schema metadata", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: { service: "1" },
  });
  srv.addGroup("group").addEndpoint("endpoint", {
    handler: (_err, msg) => {
      msg.respond();
    },
    metadata: {
      endpoint: "endpoint",
    },
  });

  await cleanup(ns, nc);
});

Deno.test("service - json reviver", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: { service: "1" },
  });
  srv.addGroup("group").addEndpoint("endpoint", {
    handler: (_err, msg) => {
      const d = msg.json<{ date: Date }>((k, v) => {
        if (k === "date") {
          return new Date(v);
        }
        return v;
      });
      assert(d.date instanceof Date);
      msg.respond();
    },
    metadata: {
      endpoint: "endpoint",
    },
  });

  await nc.request("group.endpoint", JSON.stringify({ date: Date.now() }));

  await cleanup(ns, nc);
});

async function testQueueName(nc: NatsConnection, subj: string, q?: string) {
  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: { service: "1" },
    queue: q,
  });

  srv.addEndpoint(subj, {
    handler: (_err, msg) => {
      msg.respond();
    },
  });

  const nci = nc as NatsConnectionImpl;
  const sub = nci.protocol.subscriptions.all().find((s) => {
    return s.subject === subj;
  });
  assertExists(sub);
  assertEquals(sub.queue, q !== undefined ? q : "q");
}

Deno.test("service - custom queue group", async () => {
  const { ns, nc } = await setup();
  await testQueueName(nc, "a");
  await testQueueName(nc, "b", "q1");
  await assertRejects(
    async () => {
      await testQueueName(nc, "c", "one two");
    },
    Error,
    "invalid queue name - queue name cannot contain ' '",
  );
  await assertRejects(
    async () => {
      await testQueueName(nc, "d", "  ");
    },
    Error,
    "invalid queue name - queue name cannot contain ' '",
  );

  await cleanup(ns, nc);
});

function getSubscriptionBySubject(
  nc: NatsConnection,
  subject: string,
): SubscriptionImpl | undefined {
  const nci = nc as NatsConnectionImpl;
  return nci.protocol.subscriptions.all().find((v) => {
    return v.subject === subject;
  });
}

function getEndpointInfo(
  srv: ServiceImpl,
  subject: string,
): EndpointInfo | undefined {
  return srv.endpoints().find((v) => {
    return v.subject === subject;
  });
}

function checkQueueGroup(srv: Service, subj: string, queue: string) {
  const service = srv as ServiceImpl;
  const si = getSubscriptionBySubject(service.nc, subj);
  assertExists(si);
  assertEquals(si.queue, queue);
  const ei = getEndpointInfo(service, subj);
  assertExists(ei);
  assertEquals(ei.queue_group, queue);
}

Deno.test("service - endpoint default queue group", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: { service: "1" },
  }) as ServiceImpl;

  // svc config doesn't specify a queue group so we expect q
  srv.addEndpoint("a");
  checkQueueGroup(srv, "a", "q");

  // we add another group, no queue
  const dg = srv.addGroup("G");
  dg.addEndpoint("a");
  checkQueueGroup(srv, "G.a", "q");

  // now a group with a queue - we expect endpoints/and subgroups
  // to use this unless they override
  const g = srv.addGroup("g", "qq");
  g.addEndpoint("a");
  checkQueueGroup(srv, "g.a", "qq");
  // override
  g.addEndpoint("b", { queue: "bb" });
  checkQueueGroup(srv, "g.b", "bb");
  // add a subgroup without, should inherit
  const g2 = g.addGroup("g");
  g2.addEndpoint("a");
  checkQueueGroup(srv, "g.g.a", "qq");
  // and override
  g2.addEndpoint("b", { queue: "bb" });
  checkQueueGroup(srv, "g.g.b", "bb");

  await cleanup(ns, nc);
});

Deno.test("service - endpoint no queue group", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: { service: "1" },
    // no queue
    queue: "",
  }) as ServiceImpl;

  // svc config doesn't specify a queue group so we expect q
  srv.addEndpoint("a");
  checkQueueGroup(srv, "a", "");

  // we add another group, no queue
  const dg = srv.addGroup("G");
  dg.addEndpoint("a");
  checkQueueGroup(srv, "G.a", "");

  // the above have no queue, no override, and set a queue
  const g = srv.addGroup("g", "qq");
  g.addEndpoint("a");
  checkQueueGroup(srv, "g.a", "qq");
  // override
  g.addEndpoint("b", { queue: "bb" });
  checkQueueGroup(srv, "g.b", "bb");
  // add a subgroup without, should inherit
  const g2 = g.addGroup("g");
  g2.addEndpoint("a");
  checkQueueGroup(srv, "g.g.a", "qq");

  await cleanup(ns, nc);
});

Deno.test("service - metadata is not editable", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: { service: "1", hello: "world" },
    queue: "",
  }) as ServiceImpl;

  assertThrows(
    () => {
      srv.config.metadata!.hello = "hello";
    },
    TypeError,
    "Cannot assign to read only property",
  );

  await cleanup(ns, nc);
});

Deno.test("service - close listener check", async () => {
  const { ns, nc } = await setup();

  const nci = nc as NatsConnectionImpl;
  //@ts-ignore: internal
  assertEquals(nci.closeListeners, undefined);

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: { service: "1", hello: "world" },
    queue: "",
  });

  //@ts-ignore: internal
  assertEquals(nci.closeListeners.listeners.length, 1);

  await srv.stop();
  //@ts-ignore: internal
  assertEquals(nci.closeListeners.listeners.length, 0);

  await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: { service: "1", hello: "world" },
    queue: "",
  });

  //@ts-ignore: internal
  assertEquals(nci.closeListeners.listeners.length, 1);
  await nc.close();
  //@ts-ignore: internal
  assertEquals(nci.closeListeners.listeners.length, 0);

  await cleanup(ns, nc);
});

Deno.test("service - stop should stop iterators", async () => {
  const { ns, nc } = await setup();

  const nci = nc as NatsConnectionImpl;
  //@ts-ignore: internal
  assertEquals(nci.closeListeners, undefined);

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: { service: "1", hello: "world" },
    queue: "",
  });

  const iter = srv.addEndpoint("hello");
  const done = (async () => {
    for await (const _ of iter) {
      // nothing
    }
  })().then();

  await srv.stop();

  await deadline(done, 5_000);

  await cleanup(ns, nc);
});

Deno.test("service - metadata is copied", async () => {
  const { ns, nc } = await setup();

  const svcMeta: Record<string, string> = { owner: "team-a" };
  const epMeta: Record<string, string> = { owner: "team-a" };
  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    metadata: svcMeta,
  }) as ServiceImpl;
  srv.addEndpoint("a", {
    handler: (_err, msg) => msg.respond(),
    metadata: epMeta,
  });

  // the caller's maps stay the caller's: not frozen, and changing them
  // changes nothing the service reports
  svcMeta.owner = "team-b";
  epMeta.owner = "team-b";
  const info = srv.info();
  assertEquals(info.metadata, { owner: "team-a" });
  assertEquals(info.endpoints[0].metadata, { owner: "team-a" });

  // and what the service hands out cannot be changed either
  assertThrows(() => {
    info.endpoints[0].metadata!.owner = "team-c";
  }, TypeError);
  assertEquals(srv.info().endpoints[0].metadata, { owner: "team-a" });

  await cleanup(ns, nc);
});

Deno.test("service - last_error is empty until an error is counted", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  srv.addEndpoint("fail", () => {
    throw new Error("boom");
  });

  const endpoint = async () => (await srv.stats()).endpoints![0];

  let stats = await endpoint();
  assertEquals(stats.last_error, "");

  await nc.request("fail").catch(() => {});
  stats = await endpoint();
  assertEquals(stats.num_errors, 1);
  assertEquals(stats.last_error, "boom");

  srv.reset();
  stats = await endpoint();
  assertEquals(stats.num_errors, 0);
  assertEquals(stats.last_error, "");

  await cleanup(ns, nc);
});

Deno.test("service - respondError counts as an error", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  srv.addEndpoint("bad", (_err, msg) => {
    msg.respondError(400, "bad input");
  });
  srv.addEndpoint("later", (_err, msg) => {
    // responded after the handler returned: not counted
    setTimeout(() => msg.respondError(500, "too late"), 0);
  });
  srv.addEndpoint("both", (_err, msg) => {
    msg.respondError(400, "bad input");
    throw new Error("boom");
  });

  await nc.request("bad").catch(() => {});
  await nc.request("later").catch(() => {});
  await nc.request("both").catch(() => {});

  const stats = await srv.stats();
  const endpoint = (name: string) =>
    stats.endpoints!.find((e) => e.name === name)!;

  assertEquals(endpoint("bad").num_requests, 1);
  assertEquals(endpoint("bad").num_errors, 1);
  assertEquals(endpoint("bad").last_error, "400:bad input");

  assertEquals(endpoint("later").num_requests, 1);
  assertEquals(endpoint("later").num_errors, 0);
  assertEquals(endpoint("later").last_error, "");

  // one error per request: the throw, which came last
  assertEquals(endpoint("both").num_errors, 1);
  assertEquals(endpoint("both").last_error, "boom");

  await cleanup(ns, nc);
});

Deno.test("service - respondError counts as an error in an iterator", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  const iter = srv.addEndpoint("it");
  (async () => {
    for await (const m of iter) {
      m.string() === "bad" ? m.respondError(400, "bad input") : m.respond();
    }
  })().then();

  await nc.request("it", "ok");
  await nc.request("it", "bad").catch(() => {});
  await nc.request("it", "ok");

  const stats = await srv.stats();
  const ep = stats.endpoints![0];
  assertEquals(ep.num_requests, 3);
  assertEquals(ep.num_errors, 1);
  assertEquals(ep.last_error, "400:bad input");

  await cleanup(ns, nc);
});

Deno.test("service - reset keeps started", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  srv.addEndpoint("a", (_err, msg) => msg.respond());
  await nc.request("a");

  const before = (await srv.stats()).started;
  await delay(10);
  srv.reset();
  const stats = await srv.stats();

  assertEquals(stats.started, before);
  assertEquals(stats.endpoints![0].num_requests, 0);

  await cleanup(ns, nc);
});

Deno.test("service - client fills a missing last_error", async () => {
  const { ns, nc } = await setup();

  // a service from an older version, which omits last_error when there was
  // no error
  nc.subscribe("$SRV.STATS", {
    callback: (_err, msg) => {
      msg.respond(JSON.stringify({
        type: ServiceResponseType.STATS,
        name: "old",
        id: "1",
        version: "0.0.1",
        started: new Date().toISOString(),
        endpoints: [{
          name: "a",
          subject: "a",
          queue_group: "q",
          num_requests: 0,
          num_errors: 0,
          processing_time: 0,
          average_processing_time: 0,
        }],
      }));
    },
  });

  const stats = await collect(await new Svcm(nc).client().stats());
  assertEquals(stats.length, 1);
  assertEquals(stats[0].endpoints![0].last_error, "");

  await cleanup(ns, nc);
});

Deno.test("service - empty queue is no queue at every level", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
    queue: "svcq",
  }) as ServiceImpl;

  // an endpoint that sets no queue
  srv.addEndpoint("a", { queue: "" });
  checkQueueGroup(srv, "a", "");

  // a group that sets no queue: its endpoints and subgroups have none
  const g = srv.addGroup("g", "");
  g.addEndpoint("a");
  checkQueueGroup(srv, "g.a", "");
  g.addGroup("h").addEndpoint("a");
  checkQueueGroup(srv, "g.h.a", "");
  // unless they set one
  g.addEndpoint("b", { queue: "epq" });
  checkQueueGroup(srv, "g.b", "epq");

  // an endpoint that sets no queue under a group that has one
  const q = srv.addGroup("q", "grpq");
  q.addEndpoint("a", { queue: "" });
  checkQueueGroup(srv, "q.a", "");

  // a group that sets nothing still inherits the service queue
  srv.addGroup("i").addEndpoint("a");
  checkQueueGroup(srv, "i.a", "svcq");

  await cleanup(ns, nc);
});

Deno.test("service - group and endpoint queues are validated like the service queue", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "example",
    version: "0.0.1",
  }) as ServiceImpl;

  // the names the service queue accepts are accepted
  srv.addEndpoint("ok", { handler: () => {}, queue: "work-ers_1" });
  srv.addGroup("gok", "work-ers_1").addEndpoint("e", () => {});

  // and the ones it refuses are refused
  for (const bad of ["one two", " ", "a\tb", "a.b", "a*", "a>", "a:b"]) {
    assertThrows(
      () => srv.addEndpoint("e", { handler: () => {}, queue: bad }),
      Error,
      "invalid queue name",
    );
    assertThrows(
      () => srv.addGroup("g", bad).addEndpoint("e", () => {}),
      Error,
      "invalid queue name",
    );
  }
  // nothing was subscribed for a refused endpoint
  assertEquals(getSubscriptionBySubject(nc, "e"), undefined);
  assertEquals(getSubscriptionBySubject(nc, "g.e"), undefined);

  await cleanup(ns, nc);
});

Deno.test("service - endpoints cannot use $SRV subjects", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "orders", version: "0.0.1" });

  const refused: [string, () => unknown][] = [
    ["$SRV.custom", () => srv.addEndpoint("a", { subject: "$SRV.custom" })],
    [
      "$SRV.PING.orders",
      () => srv.addEndpoint("b", { subject: "$SRV.PING.orders" }),
    ],
    ["$SRV.c", () => srv.addGroup("$SRV").addEndpoint("c")],
  ];
  for (const [subject, add] of refused) {
    assertThrows(add, Error, "$SRV is reserved", subject);
  }
  assertEquals(getSubscriptionBySubject(nc, "$SRV.custom"), undefined);
  assertEquals(getSubscriptionBySubject(nc, "$SRV.c"), undefined);
  // the internal handler is still the only one on $SRV.PING.orders
  const nci = nc as NatsConnectionImpl;
  assertEquals(
    nci.protocol.subscriptions.all().filter((s) =>
      s.subject === "$SRV.PING.orders"
    ).length,
    1,
  );
  // and still answers
  const r = await nc.request("$SRV.PING.orders");
  assertEquals(r.json<ServiceIdentity>().name, "orders");

  // $SRV anywhere but the first token, and lookalikes, are allowed
  srv.addEndpoint("d", { subject: "foo.$SRV" });
  srv.addGroup("foo").addEndpoint("e", { subject: "$SRV.PING" });
  srv.addEndpoint("f", { subject: "$SRVX.a" });
  assertExists(getSubscriptionBySubject(nc, "foo.$SRV"));
  assertExists(getSubscriptionBySubject(nc, "foo.$SRV.PING"));
  assertExists(getSubscriptionBySubject(nc, "$SRVX.a"));

  await cleanup(ns, nc);
});

Deno.test("service - prefix replaces $SRV", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({
    name: "orders",
    version: "0.0.1",
    prefix: "AcMe",
  }) as ServiceImpl;

  // the nine discovery subjects move to the prefix, its case kept
  const nci = nc as NatsConnectionImpl;
  const subjects = nci.protocol.subscriptions.all().map((s) => s.subject)
    .sort();
  const want = ["PING", "STATS", "INFO"].flatMap((v) => [
    `AcMe.${v}`,
    `AcMe.${v}.orders`,
    `AcMe.${v}.orders.${srv.id}`,
  ]).sort();
  assertEquals(subjects, want);

  // and answer there
  const r = await nc.request("AcMe.PING.orders");
  assertEquals(r.json<ServiceIdentity>().id, srv.id);
  const ids = await collect(await svc.client(undefined, "AcMe").ping("orders"));
  assertEquals(ids.map((i) => i.id), [srv.id]);

  // endpoints cannot be added under the prefix; $SRV is free again
  assertThrows(
    () => srv.addEndpoint("a", { subject: "AcMe.a" }),
    Error,
    "AcMe is reserved",
  );
  assertThrows(
    () => srv.addGroup("AcMe").addEndpoint("b"),
    Error,
    "AcMe is reserved",
  );
  srv.addEndpoint("c", { subject: "$SRV.c" });
  assertExists(getSubscriptionBySubject(nc, "$SRV.c"));

  await cleanup(ns, nc);
});

Deno.test("service - async handler is counted when it settles", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  srv.addEndpoint("slow", async (_err, msg) => {
    await delay(100);
    msg.respond();
  });

  await nc.request("slow");
  await delay(10);

  const ep = (await srv.stats()).endpoints![0];
  assertEquals(ep.num_requests, 1);
  // a lower bound only: timers may fire a little early
  assert(
    ep.processing_time >= 80_000_000,
    `processing_time ${ep.processing_time}`,
  );

  await cleanup(ns, nc);
});

Deno.test("service - prefix must be literal subject tokens", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  for (const bad of ["", "a b", "a.*", "a.>", "a..b", ".a"]) {
    await assertRejects(
      () => svc.add({ name: "orders", version: "0.0.1", prefix: bad }),
      Error,
      "invalid prefix",
    );
  }
  // several tokens are fine, as with a JetStream API prefix
  const srv = await svc.add({
    name: "orders",
    version: "0.0.1",
    prefix: "acme.srv",
  }) as ServiceImpl;
  const r = await nc.request("acme.srv.PING.orders");
  assertEquals(r.json<ServiceIdentity>().id, srv.id);

  await cleanup(ns, nc);
});

Deno.test("service - async handler rejection is counted and answered", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  srv.addEndpoint("bad", async () => {
    await delay(10);
    throw new ServiceError(400, "bad input");
  });
  srv.addEndpoint("boom", async () => {
    await delay(10);
    throw new Error("boom");
  });

  const r = await nc.request("bad");
  assertEquals(r.headers?.get(ServiceErrorCodeHeader), "400");
  assertEquals(r.headers?.get(ServiceErrorHeader), "bad input");
  const r2 = await nc.request("boom");
  assertEquals(r2.headers?.get(ServiceErrorCodeHeader), "500");
  assertEquals(r2.headers?.get(ServiceErrorHeader), "boom");

  const stats = await srv.stats();
  const ep = (name: string) => stats.endpoints!.find((e) => e.name === name)!;
  assertEquals(ep("bad").num_requests, 1);
  assertEquals(ep("bad").num_errors, 1);
  assertEquals(ep("bad").last_error, "bad input");
  assertEquals(ep("boom").num_errors, 1);
  assertEquals(ep("boom").last_error, "boom");

  await cleanup(ns, nc);
});

Deno.test("service - handlers failing with non-errors are counted and answered", async () => {
  const { ns, nc } = await setup();
  const unhandled: unknown[] = [];
  const onRejection = (e: PromiseRejectionEvent) => {
    unhandled.push(e.reason);
    e.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  srv.addEndpoint("undefined", async () => {
    await Promise.reject();
  });
  srv.addEndpoint("null", async () => {
    await Promise.reject(null);
  });
  srv.addEndpoint("string", async () => {
    await Promise.reject("bad thing");
  });
  srv.addEndpoint("sync", () => {
    throw "sync bad thing";
  });
  srv.addEndpoint("unprintable", async () => {
    await Promise.reject(Object.create(null));
  });
  // a named handler is reported, no queue isn't
  async function namedHandler(): Promise<void> {
    await Promise.reject("named bad thing");
  }
  srv.addEndpoint("named", { handler: namedHandler, queue: "" });

  const m = (
    name: string,
    how: string,
    q = ', queue "q"',
    fn = "",
  ) => `endpoint "${name}" (${name}${q}) handler${fn} ${how}`;
  const expected: Record<string, string> = {
    undefined: m("undefined", "rejected with undefined"),
    null: m("null", "rejected with null"),
    string: m("string", 'rejected with "bad thing"'),
    sync: m("sync", 'threw "sync bad thing"'),
    unprintable: m("unprintable", "rejected with an unprintable value"),
    named: m("named", 'rejected with "named bad thing"', "", " namedHandler"),
  };
  for (const [name, message] of Object.entries(expected)) {
    const r = await nc.request(name);
    assertEquals(r.headers?.get(ServiceErrorCodeHeader), "500");
    assertEquals(r.headers?.get(ServiceErrorHeader), message);
  }

  const stats = await srv.stats();
  for (const [name, message] of Object.entries(expected)) {
    const ep = stats.endpoints!.find((e) => e.name === name)!;
    assertEquals(ep.num_requests, 1);
    assertEquals(ep.num_errors, 1);
    assertEquals(ep.last_error, message);
  }
  await delay(20);
  globalThis.removeEventListener("unhandledrejection", onRejection);
  assertEquals(unhandled, []);

  await cleanup(ns, nc);
});

Deno.test("service - async handler respondError is counted", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  srv.addEndpoint("after", async (_err, msg) => {
    await delay(10);
    msg.respondError(400, "bad input");
  });
  srv.addEndpoint("before", async (_err, msg) => {
    msg.respondError(400, "bad input");
    await delay(10);
    throw new Error("boom");
  });

  await nc.request("after");
  await nc.request("before");
  // the reply to "before" arrives before its handler settles
  await delay(50);

  const stats = await srv.stats();
  const ep = (name: string) => stats.endpoints!.find((e) => e.name === name)!;
  assertEquals(ep("after").num_errors, 1);
  assertEquals(ep("after").last_error, "400:bad input");
  // one request, one error: the rejection, which came last
  assertEquals(ep("before").num_requests, 1);
  assertEquals(ep("before").num_errors, 1);
  assertEquals(ep("before").last_error, "boom");

  await cleanup(ns, nc);
});

Deno.test("service - a request gets at most one error response", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  const second: boolean[] = [];
  // data responses then a throw: the data, then one error response
  srv.addEndpoint("data-sync", (_err, msg) => {
    msg.respond("a");
    msg.respond("b");
    throw new Error("boom");
  });
  srv.addEndpoint("data-async", async (_err, msg) => {
    msg.respond("a");
    msg.respond("b");
    await delay(10);
    throw new Error("boom");
  });
  // an error response then a throw: no second error response
  srv.addEndpoint("error-sync", (_err, msg) => {
    msg.respondError(400, "bad input");
    throw new Error("boom");
  });
  srv.addEndpoint("error-async", async (_err, msg) => {
    msg.respondError(400, "bad input");
    await delay(10);
    throw new Error("boom");
  });
  // respondError twice: the second is refused
  srv.addEndpoint("twice", (_err, msg) => {
    msg.respondError(400, "first");
    second.push(msg.respondError(500, "second"));
  });

  const replies = async (subj: string): Promise<Msg[]> => {
    const inbox = createInbox();
    const sub = nc.subscribe(inbox);
    nc.publish(subj, undefined, { reply: inbox });
    await delay(100);
    sub.unsubscribe();
    return collect(sub);
  };
  const errorOf = (m: Msg) => m.headers?.get(ServiceErrorHeader) || "";

  for (const subj of ["data-sync", "data-async"]) {
    const r = await replies(subj);
    assertEquals(r.map((m) => m.string()), ["a", "b", ""], subj);
    assertEquals(r.map(errorOf), ["", "", "boom"], subj);
  }
  for (const subj of ["error-sync", "error-async"]) {
    const r = await replies(subj);
    assertEquals(r.map(errorOf), ["bad input"], subj);
  }
  const r = await replies("twice");
  assertEquals(r.map(errorOf), ["first"]);
  assertEquals(second, [false]);

  const stats = await srv.stats();
  const ep = (name: string) => stats.endpoints!.find((e) => e.name === name)!;
  for (const name of ["data-sync", "data-async", "error-sync", "error-async"]) {
    assertEquals(ep(name).num_requests, 1, name);
    assertEquals(ep(name).num_errors, 1, name);
    assertEquals(ep(name).last_error, "boom", name);
  }
  assertEquals(ep("twice").num_errors, 1);
  assertEquals(ep("twice").last_error, "400:first");

  await cleanup(ns, nc);
});

Deno.test("service - async handler that never replies is counted", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  const stored = deferred<void>();
  const failed = deferred<void>();
  srv.addEndpoint("ingest", async () => {
    // stands in for storing the data, with no reply
    await delay(50);
    stored.resolve();
  });
  srv.addEndpoint("fail", async () => {
    await delay(10);
    failed.resolve();
    throw new Error("disk full");
  });

  nc.publish("ingest");
  nc.publish("fail");
  await stored;
  await failed;
  await delay(10);

  const stats = await srv.stats();
  const ep = (name: string) => stats.endpoints!.find((e) => e.name === name)!;
  assertEquals(ep("ingest").num_requests, 1);
  assertEquals(ep("ingest").num_errors, 0);
  assert(ep("ingest").processing_time >= 40_000_000);
  assertEquals(ep("fail").num_requests, 1);
  assertEquals(ep("fail").num_errors, 1);
  assertEquals(ep("fail").last_error, "disk full");

  await cleanup(ns, nc);
});

Deno.test("service - multi-line error descriptions are sent on one line", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const srv = await svc.add({ name: "example", version: "0.0.1" });
  srv.addEndpoint("sync", () => {
    throw new Error("line one\nline two");
  });
  srv.addEndpoint("async", async () => {
    await delay(10);
    throw new ServiceError(400, "line one\r\nline two");
  });
  srv.addEndpoint("respond", (_err, msg) => {
    msg.respondError(400, "line one\nline two");
  });

  for (const subj of ["sync", "async", "respond"]) {
    const r = await nc.request(subj);
    assertEquals(r.headers?.get(ServiceErrorHeader), "line one line two");
  }

  await cleanup(ns, nc);
});

Deno.test("service - async rejection after the connection closed does not throw", async () => {
  const { ns, nc } = await setup();

  const svc = new Svcm(nc);
  const started = deferred<void>();
  const gate = deferred<void>();
  const srv = await svc.add({ name: "late", version: "0.0.1" });
  srv.addEndpoint("late", async () => {
    started.resolve();
    await gate;
    throw new Error("boom");
  });

  nc.publish("late", undefined, { reply: createInbox() });
  await started;
  await nc.close();
  // the error reply now fails to publish; an unhandled rejection would fail
  // the test
  gate.resolve();
  await delay(50);

  await ns.stop();
});
