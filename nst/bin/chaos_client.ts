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

// Long-running observer client. Connects N clients to a NATS cluster and
// renders a compact in-place dashboard showing per-client connection state,
// time in state, current server, and disconnect count. Pair with
// `cluster.ts --chaos` to exercise reconnect logic over time.
//
// Usage:
//   deno run -A nst/bin/chaos_client.ts --servers 127.0.0.1:4222,127.0.0.1:4223
//   deno run -A nst/bin/chaos_client.ts --servers ws://127.0.0.1:80 --clients 5
//
// Flags:
//   --servers <list>  comma-separated host:port (or ws[s]://host:port)
//   --clients <n>     number of independent connections (default 1)
//   --interval <ms>   heartbeat publish interval per client (default 1000)

import { parseArgs } from "@std/cli";
import { green, red, yellow } from "@std/fmt/colors";
import { connect } from "@nats-io/transport-deno";
import { hasWsProtocol, wsconnect } from "@nats-io/nats-core/internal";
import type { NatsConnection } from "@nats-io/nats-core";
import {
  clearScreen,
  coalescingScheduler,
  fmtDuration,
  MAX_WIDTH,
  palette,
  writeFrame,
} from "./_tui.ts";

const argv = parseArgs(Deno.args, {
  string: ["servers"],
  default: {
    servers: "127.0.0.1:4222",
    clients: 1,
    interval: 1000,
  },
});

const servers = (argv.servers as string).split(",").map((s) => s.trim()).filter(
  (s) => s.length,
);
const numClients = Math.max(1, Number(argv.clients));
const heartbeatMs = Number(argv.interval);

const connectFn = hasWsProtocol({ servers }) ? wsconnect : connect;

type State = "C" | "D" | "R";

type ClientState = {
  id: number;
  nc: NatsConnection;
  state: State;
  stateEnteredAt: number;
  disconnects: number;
  currentServer: string;
  heartbeatTimer?: ReturnType<typeof setInterval>;
};

const clients: ClientState[] = [];
const startedAt = Date.now();
const isTty = Deno.stdout.isTerminal();

function symbol(state: State): string {
  switch (state) {
    case "C":
      return green("●");
    case "D":
      return red("○");
    case "R":
      return yellow("⟳");
  }
}

type ServerEntry = { label: string; color: (s: string) => string };
const serverRegistry = new Map<string, ServerEntry>();
function registerServer(listen: string): ServerEntry {
  let e = serverRegistry.get(listen);
  if (!e) {
    e = {
      label: `S${serverRegistry.size + 1}`,
      color: palette[serverRegistry.size % palette.length],
    };
    serverRegistry.set(listen, e);
  }
  return e;
}

const scheduleRender = coalescingScheduler(() => render());

function setState(c: ClientState, s: State, server?: string) {
  if (c.state !== s) {
    c.state = s;
    c.stateEnteredAt = Date.now();
  }
  if (server !== undefined) c.currentServer = server;
  scheduleRender();
}

async function spawnClient(id: number): Promise<ClientState> {
  const nc = await connectFn({
    servers,
    reconnectTimeWait: 250,
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
    name: `chaos-${id}`,
  });
  const c: ClientState = {
    id,
    nc,
    state: "C",
    stateEnteredAt: Date.now(),
    disconnects: 0,
    currentServer: nc.getServer(),
  };
  (async () => {
    for await (const e of nc.status()) {
      switch (e.type) {
        case "disconnect":
          c.disconnects++;
          setState(c, "D", "");
          break;
        case "reconnecting":
          setState(c, "R");
          break;
        case "reconnect":
          setState(c, "C", e.server);
          break;
      }
    }
  })().catch(() => {});
  const subj = `_CHAOS.${id}.hb`;
  nc.subscribe(subj, { callback: () => {} });
  c.heartbeatTimer = setInterval(() => {
    try {
      nc.publish(subj);
    } catch {
      // publish during disconnect — silent
    }
  }, heartbeatMs);
  return c;
}

function render(): void {
  if (!isTty) return;
  const out: string[] = [];
  out.push(
    `NATS Chaos Client (${clients.length} clients)   up=${
      fmtDuration(Date.now() - startedAt)
    }`,
  );
  // legend only contains servers currently held by at least one client.
  // Stale entries from old clusters drop on the next render. Labels stay
  // stable across the run (assigned once via registerServer).
  const live = new Set<string>();
  for (const c of clients) {
    if (c.state === "C" && c.currentServer) live.add(c.currentServer);
  }
  if (live.size > 0) {
    const sep = "   ";
    let cur = "";
    let curLen = 0;
    for (const listen of live) {
      const e = registerServer(listen);
      const rawLen = e.label.length + 3 + listen.length;
      const colored = `${e.color(`[${e.label}]`)} ${listen}`;
      if (curLen === 0) {
        cur = colored;
        curLen = rawLen;
      } else if (curLen + sep.length + rawLen > MAX_WIDTH) {
        out.push(cur);
        cur = colored;
        curLen = rawLen;
      } else {
        cur += sep + colored;
        curLen += sep.length + rawLen;
      }
    }
    if (cur) out.push(cur);
  }
  out.push("─".repeat(MAX_WIDTH));
  const W = { id: 3, sym: 1, uptime: 7, server: 7, dc: 5 };
  out.push(
    [
      "#".padStart(W.id),
      "S".padEnd(W.sym),
      "uptime".padEnd(W.uptime),
      "server".padEnd(W.server),
      "d/c".padEnd(W.dc),
    ].join("  "),
  );
  for (const c of clients) {
    const since = fmtDuration(Date.now() - c.stateEnteredAt);
    let serverCell: string;
    if (c.state === "C" && c.currentServer) {
      const e = registerServer(c.currentServer);
      serverCell = e.color(e.label.padEnd(W.server));
    } else {
      serverCell = "-".padEnd(W.server);
    }
    out.push(
      [
        String(c.id).padStart(W.id),
        symbol(c.state),
        since.padEnd(W.uptime),
        serverCell,
        String(c.disconnects).padEnd(W.dc),
      ].join("  "),
    );
  }
  // ANSI: home, clear screen, write
  writeFrame(out.join("\n"));
}

function fallbackLog(): void {
  if (isTty) return;
  // non-TTY: print one summary line per render cycle
  const states = clients.map((c) => `${c.id}=${c.state}`).join(" ");
  console.log(
    `up=${fmtDuration(Date.now() - startedAt)} ${states} disc=${
      clients.reduce((a, c) => a + c.disconnects, 0)
    }`,
  );
}

try {
  for (let i = 1; i <= numClients; i++) {
    clients.push(await spawnClient(i));
  }
} catch (err) {
  console.error(`connect failed: ${(err as Error).message}`);
  Deno.exit(1);
}

const renderTimer = setInterval(() => {
  render();
  fallbackLog();
}, 1000);

const shutdown = async () => {
  clearInterval(renderTimer);
  for (const c of clients) {
    if (c.heartbeatTimer !== undefined) clearInterval(c.heartbeatTimer);
  }
  await Promise.all(clients.map((c) => c.nc.close()));
  if (isTty) clearScreen();
  console.log(`shutdown: ${clients.length} clients`);
  for (const c of clients) {
    console.log(
      `  client ${c.id}: server=${
        c.currentServer || "-"
      } disconnects=${c.disconnects}`,
    );
  }
  Deno.exit(0);
};

const onSignal = () => {
  shutdown().catch((e) => {
    console.error(e);
    Deno.exit(1);
  });
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

render();
