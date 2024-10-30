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
import { _setup, cleanup, connect } from "test_helpers";
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
} from "jsr:@std/assert";

import {
  collect,
  createInbox,
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
  Svc,
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
  const { ns, nc } = await _setup(connect, {}, {});
  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect, {}, {});
  const subj = createInbox();
  const svc = new Svc(nc);

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
  const { ns, nc } = await _setup(connect, {}, {});
  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect, {
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

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect, {
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

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);
  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);
  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);
  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);
  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);
  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const config = {
    name: "test",
    version: "2.0.0",
    // @ts-ignore: test
    statsHandler: "hello world",
  };

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);
  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  assertEquals(stat.last_error, undefined);

  await cleanup(ns, nc);
});

Deno.test("service - iter", async () => {
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);
  const test = (v?: string): Promise<Service> => {
    const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
  const svc = new Svc(nc);
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
  const { ns, nc } = await _setup(connect);
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
  const { ns, nc } = await _setup(connect);

  const svc = new Svc(nc);
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
