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

import { NatsServer } from "../src/launcher.ts";
import { parseArgs } from "@std/cli";
import { gray, green, red, yellow } from "@std/fmt/colors";
import {
  clearScreen,
  coalescingScheduler,
  fmtDuration,
  MAX_WIDTH,
  palette,
  writeFrame,
} from "./_tui.ts";

const defaults = {
  c: 3,
  p: 4222,
  w: 80,
  chaos: false,
  cert: "",
  key: "",
};

const argv = parseArgs(Deno.args, {
  alias: {
    "p": ["port"],
    "c": ["count"],
    "d": ["debug"],
    "j": ["jetstream"],
    "w": ["websocket"],
  },
  default: defaults,
  boolean: ["debug", "jetstream", "server-debug", "chaos"],
});

if (argv.h || argv.help) {
  console.log(
    "usage: cluster [--count 3] [--port 4222] [--key path] [--cert path] [--websocket 80] [--debug] [--jetstream] [--chaos]\n",
  );
  Deno.exit(0);
}

const count = argv["count"] as number || 3;
const port = argv["port"] as number ?? 4222;
const cert = argv["cert"] as string || undefined;
const key = argv["key"] as string || undefined;

if (cert?.length) {
  await Deno.stat(cert).catch((err) => {
    console.error(`error loading certificate: ${err.message}`);
    Deno.exit(1);
  });
}
if (key?.length) {
  await Deno.stat(key).catch((err) => {
    console.error(`error loading certificate key: ${err.message}`);
    Deno.exit(1);
  });
}
let wsport = argv["websocket"] as number;
if (wsport === 80 && cert?.length) {
  wsport = 443;
}

const isTty = Deno.stdout.isTerminal();

type ServerState = "running" | "restarting" | "failed";

type ServerMeta = {
  idx: number;
  label: string;
  color: (s: string) => string;
  state: ServerState;
  pid: number;
  port: number;
  websocket?: number;
  cluster: number;
  monitoring?: number;
  configFile: string;
  restarts: number;
  ns: NatsServer | null;
};

const meta: ServerMeta[] = [];
const events: string[] = [];
const startedAt = Date.now();
let chaosTimer: number | undefined;

function pushEvent(line: string) {
  const ts = new Date().toISOString().substring(11, 19);
  if (!isTty) {
    console.log(`${ts}  ${line}`);
  }
  events.unshift(`${gray(ts)}  ${line}`);
  if (events.length > 8) events.pop();
  scheduleRender();
}

const scheduleRender = coalescingScheduler(() => render());

function stateLabel(s: ServerState): string {
  switch (s) {
    case "running":
      return green("● running   ");
    case "restarting":
      return yellow("⟳ restarting");
    case "failed":
      return red("✗ failed    ");
  }
}

function render(): void {
  if (!isTty) return;
  const out: string[] = [];
  const chaosState = chaosTimer === undefined
    ? gray("chaos: OFF")
    : red("chaos: ON ");
  out.push(
    `NATS Cluster (${meta.length} servers)   ${chaosState}   up=${
      fmtDuration(Date.now() - startedAt)
    }`,
  );
  out.push("─".repeat(MAX_WIDTH));
  const W = {
    s: 4,
    state: 12,
    pid: 6,
    nats: 6,
    ws: 6,
    cluster: 7,
    http: 6,
    restarts: 4,
  };
  out.push(
    [
      "S".padEnd(W.s),
      "state".padEnd(W.state),
      "pid".padEnd(W.pid),
      "nats".padEnd(W.nats),
      "ws".padEnd(W.ws),
      "cluster".padEnd(W.cluster),
      "http".padEnd(W.http),
      "restarts".padEnd(W.restarts),
    ].join("  "),
  );
  for (const m of meta) {
    const lbl = m.color(`[${m.label}]`.padEnd(W.s));
    out.push(
      [
        lbl,
        stateLabel(m.state),
        String(m.pid).padEnd(W.pid),
        String(m.port).padEnd(W.nats),
        String(m.websocket || "-").padEnd(W.ws),
        String(m.cluster).padEnd(W.cluster),
        String(m.monitoring || "-").padEnd(W.http),
        String(m.restarts).padEnd(W.restarts),
      ].join("  "),
    );
  }
  if (events.length > 0) {
    out.push("");
    out.push("recent:");
    for (const e of events) out.push(`  ${e}`);
  }
  out.push("");
  out.push(
    `${gray("ctrl+c")} terminate   ${gray("ctrl+t")} toggle chaos`,
  );
  writeFrame(out.join("\n"));
}

function addServer(idx: number, ns: NatsServer): ServerMeta {
  const m: ServerMeta = {
    idx,
    label: `S${idx + 1}`,
    color: palette[idx % palette.length],
    state: "running",
    pid: ns.pid(),
    port: ns.port,
    websocket: ns.websocket,
    cluster: ns.cluster!,
    monitoring: ns.monitoring,
    configFile: ns.configFile,
    restarts: 0,
    ns,
  };
  meta.push(m);
  return m;
}

let cluster: NatsServer[];

try {
  let base = {
    port,
    debug: false,
    http: 8222,
    websocket: {
      port: wsport,
      no_tls: true,
      compression: true,
    },
  };

  const serverDebug = argv["debug"];
  if (serverDebug) {
    base.debug = true;
  }

  if (cert) {
    base = Object.assign(base, {
      tls: { cert_file: cert, key_file: key },
      websocket: {
        port: wsport,
        no_tls: false,
        compression: true,
        tls: { cert_file: cert, key_file: key },
      },
    });
  }

  cluster = argv.jetstream
    ? await NatsServer.jetstreamCluster(
      count,
      Object.assign(base, {
        jetstream: { max_file_store: -1, max_mem_store: -1 },
      }),
    )
    : await NatsServer.cluster(count, base, serverDebug);

  cluster.forEach((s, i) => addServer(i, s));
  pushEvent(`cluster started (${cluster.length} servers)`);
  if (!isTty) {
    for (const m of meta) {
      console.log(
        `[${m.label}] pid=${m.pid} nats=${m.port} ws=${
          m.websocket ?? "-"
        } cluster=${m.cluster} http=${m.monitoring ?? "-"}`,
      );
    }
  }

  render();
  if (argv.chaos === true && confirm("start chaos?")) {
    chaos(cluster, 0);
  }
  setInterval(render, 1000);
  installSignals();
} catch (err) {
  console.error(err);
  Deno.exit(1);
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min) + min);
}

function chaos(cluster: NatsServer[], delay: number) {
  setTimeout(() => {
    chaosTimer = setInterval(() => restart(cluster), 3000);
    scheduleRender();
  }, delay);
}

function restart(cluster: NatsServer[]) {
  const millis = randomBetween(0, 10000);
  const idx = randomBetween(0, cluster.length);
  if (cluster[idx] === null) {
    setTimeout(() => restart(cluster), 100);
    return;
  }
  const old = cluster[idx];
  // @ts-ignore: test
  cluster[idx] = null;
  const m = meta[idx];
  m.state = "restarting";
  scheduleRender();
  setTimeout(() => {
    const oldPid = old.pid();
    pushEvent(
      `${m.color(m.label)} restarting (pid ${oldPid}, port ${old.port})`,
    );
    old.restart()
      .then((s) => {
        s.rgb = old.rgb;
        cluster[idx] = s;
        m.ns = s;
        m.pid = s.pid();
        m.state = "running";
        m.restarts++;
        pushEvent(
          `${m.color(m.label)} replaced pid ${oldPid} → ${s.pid()}`,
        );
      })
      .catch((err) => {
        m.state = "failed";
        pushEvent(`${m.color(m.label)} failed to restart: ${err.message}`);
      });
  }, millis);
}

function installSignals(): void {
  Deno.addSignalListener("SIGTERM", () => {
    Deno.exit();
  });
  Deno.addSignalListener("SIGINT", () => {
    if (isTty) {
      clearScreen();
    }
    Deno.exit();
  });
  Deno.addSignalListener("SIGINFO", () => {
    if (chaosTimer === undefined) {
      pushEvent("chaos: ON");
      chaos(cluster, 0);
      return;
    }
    clearInterval(chaosTimer);
    chaosTimer = undefined;
    pushEvent("chaos: OFF");
  });
}
