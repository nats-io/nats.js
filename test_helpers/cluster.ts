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

import { NatsServer } from "./launcher.ts";
import { parseArgs } from "@std/cli";
import { rgb24 } from "@std/fmt/colors";

const defaults = {
  c: 3,
  p: 4222,
  w: 80,
  chaos: false,
  cert: "",
  key: "",
};

const argv = parseArgs(
  Deno.args,
  {
    alias: {
      "p": ["port"],
      "c": ["count"],
      "d": ["debug"],
      "j": ["jetstream"],
      "w": ["websocket"],
    },
    default: defaults,
    boolean: ["debug", "jetstream", "server-debug", "chaos"],
  },
);

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

let chaosTimer: number | undefined;
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
      tls: {
        cert_file: cert,
        key_file: key,
      },
      websocket: {
        port: wsport,
        no_tls: false,
        compression: true,
        tls: {
          cert_file: cert,
          key_file: key,
        },
      },
    });
  }

  cluster = argv.jetstream
    ? await NatsServer.jetstreamCluster(
      count,
      Object.assign(
        base,
        Object.assign(base, {
          jetstream: {
            max_file_store: -1,
            max_mem_store: -1,
          },
        }),
      ),
    )
    : await NatsServer.cluster(
      count,
      Object.assign(base),
      serverDebug,
    );

  cluster.forEach((s) => {
    const pid = rgb24(`[${s.process.pid}]`, s.rgb);
    console.log(`${pid} config ${s.configFile}
\tnats://${s.hostname}:${s.port}
\tws${cert ? "s" : ""}://${s.hostname}:${s.websocket}
\tcluster://${s.hostname}:${s.cluster}
\thttp://127.0.0.1:${s.monitoring}
${argv.jetstream ? `\tstore: ${s.config?.jetstream?.store_dir}` : ""}`);
  });

  if (argv.chaos === true && confirm("start chaos?")) {
    chaos(cluster, 0);
  }
  waitForStop();
} catch (err) {
  console.error(err);
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min) + min);
}

function chaos(cluster: NatsServer[], delay: number) {
  setTimeout(() => {
    chaosTimer = setInterval(() => {
      restart(cluster);
    }, 3000);
  }, delay);
}

function restart(cluster: NatsServer[]) {
  const millis = randomBetween(0, 10000);
  const idx = randomBetween(0, cluster.length);
  if (cluster[idx] === null) {
    // try again
    setTimeout(() => {
      restart(cluster);
    });
    return;
  }
  const old = cluster[idx];
  // @ts-ignore: test
  cluster[idx] = null;
  setTimeout(() => {
    const oldPid = old.pid();
    console.log(
      rgb24(
        `[${oldPid}] chaos is restarting server at port ${old.port}`,
        old.rgb,
      ),
    );
    old.restart()
      .then((s) => {
        s.rgb = old.rgb;
        cluster[idx] = s;
        console.log(rgb24(`[${s.pid()}] replaces PID ${oldPid}`, s.rgb));
      }).catch((err) => {
        console.log(`failed to replace ${oldPid}: ${err.message}`);
        console.log(`to manually restart: nats-server -c ${old.configFile}`);
      });
  }, millis);
}

function waitForStop(): void {
  console.log("control+c to terminate");
  Deno.addSignalListener("SIGTERM", () => {
    Deno.exit();
  });

  console.log("control+t to stop/restart chaos");
  Deno.addSignalListener("SIGINFO", () => {
    if (chaosTimer === undefined) {
      console.log("restarting chaos...");
      console.log("control+t to stop chaos");
      console.log("control+c to terminate");

      chaos(cluster, 0);
      return;
    }
    clearInterval(chaosTimer);
    chaosTimer = undefined;
    console.log("control+t to restart chaos");
    console.log("control+c to terminate");
    console.log("monitoring can be accessed:");
    for (const s of cluster) {
      console.log(`http://127.0.0.1:${s?.monitoring}`);
    }
  });
}
