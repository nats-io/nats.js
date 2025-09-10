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
import {
  isIPV4OrHostname,
  Servers,
  setTransportFactory,
} from "../src/internal_mod.ts";
import type { ServerInfo } from "../src/internal_mod.ts";
import { assertEquals } from "@std/assert";

Deno.test("servers - single", () => {
  const servers = new Servers(["127.0.0.1:4222"], { randomize: false });
  assertEquals(servers.length(), 1);
  assertEquals(servers.getServers().length, 1);
  assertEquals(servers.getCurrentServer().listen, "127.0.0.1:4222");
  let ni = 0;
  servers.getServers().forEach((s) => {
    if (s.gossiped) {
      ni++;
    }
  });
  assertEquals(ni, 0);
});

Deno.test("servers - multiples", () => {
  const servers = new Servers(["h:1", "h:2"], { randomize: false });
  assertEquals(servers.length(), 2);
  assertEquals(servers.getServers().length, 2);
  assertEquals(servers.getCurrentServer().listen, "h:1");
  let ni = 0;
  servers.getServers().forEach((s) => {
    if (s.gossiped) {
      ni++;
    }
  });
  assertEquals(ni, 0);
});

function servInfo(): ServerInfo {
  return {
    max_payload: 1,
    client_id: 1,
    proto: 1,
    version: "1",
  } as ServerInfo;
}

Deno.test("servers - add/delete", () => {
  const servers = new Servers(["127.0.0.1:4222"], { randomize: false });
  assertEquals(servers.length(), 1);
  let ce = servers.update(Object.assign(servInfo(), { connect_urls: ["h:1"] }));
  assertEquals(ce.added.length, 1);
  assertEquals(ce.deleted.length, 0);
  assertEquals(servers.length(), 2);
  let gossiped = servers.getServers().filter((s) => {
    return s.gossiped;
  });
  assertEquals(gossiped.length, 1);

  ce = servers.update(Object.assign(servInfo(), { connect_urls: [] }));
  assertEquals(ce.added.length, 0);
  assertEquals(ce.deleted.length, 1);
  assertEquals(servers.length(), 1);

  gossiped = servers.getServers().filter((s) => {
    return s.gossiped;
  });
  assertEquals(gossiped.length, 0);
});

Deno.test("servers - url parse fn", () => {
  const fn = (s: string): string => {
    return `x://${s}`;
  };
  setTransportFactory({ urlParseFn: fn });
  const s = new Servers(["127.0.0.1:4222"], { randomize: false });
  s.update(Object.assign(servInfo(), { connect_urls: ["h:1", "j:2/path"] }));

  const servers = s.getServers();
  assertEquals(servers[0].src, "x://127.0.0.1:4222");
  assertEquals(servers[1].src, "x://h:1");
  assertEquals(servers[2].src, "x://j:2/path");
  setTransportFactory({ urlParseFn: undefined });
});

Deno.test("servers - save tls name", () => {
  const servers = new Servers(["h:1", "h:2"], { randomize: false });
  servers.addServer("127.1.0.0", true);
  servers.addServer("127.1.2.0", true);
  servers.updateTLSName();
  assertEquals(servers.length(), 4);
  assertEquals(servers.getServers().length, 4);
  assertEquals(servers.getCurrentServer().listen, "h:1");

  const gossiped = servers.getServers().filter((s) => {
    return s.gossiped;
  });
  assertEquals(gossiped.length, 2);
  gossiped.forEach((sn) => {
    assertEquals(sn.tlsName, "h");
  });
});

Deno.test("servers - port 80", () => {
  function t(hp: string, port: number) {
    const servers = new Servers([hp]);
    const s = servers.getCurrentServer();
    assertEquals(s.port, port);
  }
  t("localhost:80", 80);
  t("localhost:443", 443);
  t("localhost:201", 201);
  t("localhost", 4222);
  t("localhost/foo", 4222);
  t("localhost:2342/foo", 2342);
  t("[2001:db8:4006:812::200e]:8080", 8080);
  t("::1", 4222);
});

Deno.test("servers - hostname only", () => {
  assertEquals(isIPV4OrHostname("hostname"), true);
  assertEquals(isIPV4OrHostname("hostname:40"), true);
  assertEquals(isIPV4OrHostname("::ffff:35.234.43.228"), false);
});
