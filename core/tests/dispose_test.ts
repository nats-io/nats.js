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
import { cleanup, NatsServer, setup } from "nst";
import { connect } from "./connect.ts";
import { createInbox } from "../src/internal_mod.ts";
import type { NatsConnection, Subscription } from "../src/mod.ts";

Deno.test("dispose - connection await using calls drain", async () => {
  const ns = await NatsServer.start();
  let captured: NatsConnection;
  {
    await using nc = await connect({ port: ns.port });
    captured = nc;
    assertEquals(nc.isClosed(), false);
  }
  assert(captured!.isClosed(), "connection should be closed after scope exit");
  assertEquals(await captured!.closed(), undefined);
  await ns.stop();
});

Deno.test("dispose - connection async dispose is idempotent when closed", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  await nc.close();
  assert(nc.isClosed());
  // should resolve, not reject
  await nc[Symbol.asyncDispose]();
  await ns.stop();
});

Deno.test("dispose - connection async dispose awaits in-flight drain", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const draining = nc.drain();
  await nc[Symbol.asyncDispose]();
  await draining;
  assert(nc.isClosed());
  await ns.stop();
});

Deno.test("dispose - subscription await using drains", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const subj = createInbox();
  let count = 0;
  let captured: Subscription;
  {
    await using sub = nc.subscribe(subj, {
      callback: () => {
        count++;
      },
    });
    captured = sub;
    nc.publish(subj);
    nc.publish(subj);
    await nc.flush();
  }
  assert(
    captured!.isClosed(),
    "subscription should be closed after scope exit",
  );
  assertEquals(await captured!.closed, undefined);
  assertEquals(count, 2);
  await nc.close();
  await ns.stop();
});

Deno.test("dispose - iterator subscription await using drains", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const subj = createInbox();
  let count = 0;
  let captured: Subscription;
  {
    await using sub = nc.subscribe(subj, { max: 2 });
    captured = sub;
    const iter = (async () => {
      for await (const _ of sub) {
        count++;
      }
    })();
    nc.publish(subj);
    nc.publish(subj);
    await iter;
  }
  assert(captured!.isClosed());
  assertEquals(await captured!.closed, undefined);
  assertEquals(count, 2);
  await nc.close();
  await ns.stop();
});

Deno.test("dispose - iterator subscription closed promise resolves on dispose", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const subj = createInbox();
  const sub = nc.subscribe(subj);
  const iter = (async () => {
    for await (const _ of sub) {
      // drain msgs
    }
  })();
  await sub[Symbol.asyncDispose]();
  await iter;
  assert(sub.isClosed());
  assertEquals(await sub.closed, undefined);
  await nc.close();
  await ns.stop();
});

Deno.test("dispose - subscription async dispose is idempotent when closed", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const sub = nc.subscribe(createInbox(), { callback: () => {} });
  await sub.drain();
  assert(sub.isClosed());
  assertEquals(await sub.closed, undefined);
  await sub[Symbol.asyncDispose]();
  await nc.close();
  await ns.stop();
});

Deno.test("dispose - subscription async dispose awaits in-flight drain", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const sub = nc.subscribe(createInbox(), { callback: () => {} });
  const draining = sub.drain();
  await sub[Symbol.asyncDispose]();
  await draining;
  assert(sub.isClosed());
  assertEquals(await sub.closed, undefined);
  await nc.close();
  await ns.stop();
});

Deno.test("dispose - subscription async dispose when connection closed", async () => {
  const ns = await NatsServer.start();
  const nc = await connect({ port: ns.port });
  const sub = nc.subscribe(createInbox());
  await nc.close();
  // should resolve, not throw
  await sub[Symbol.asyncDispose]();
  await ns.stop();
});

Deno.test("dispose - script use", async () => {
  const { ns, nc } = await setup();
  nc.subscribe("q", {
    callback: (_, msg) => {
      msg.respond();
    },
  });

  let counter = 0;

  const oneShot = async function (): Promise<void> {
    counter++;
    await using c = await connect({ port: ns.port });
    c.closed().then(() => {
      console.log("connection", counter, "closed");
    });

    await using sub = c.subscribe("q");
    (async () => {
      for await (const _ of sub) {
        console.log("sub", counter, "got message");
      }
    })().catch((_) => {});

    sub.closed.then(() => {
      console.log("sub", counter, "closed");
    });
    await c.request("q");
  };

  await oneShot();
  await oneShot();

  await cleanup(ns, nc);
});
