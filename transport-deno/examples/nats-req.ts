#!/usr/bin/env deno run --allow-all --unstable

import { parseArgs } from "@std/cli";
import {
  connect,
  type ConnectionOptions,
  credsAuthenticator,
  delay,
} from "@nats-io/transport-deno";

const argv = parseArgs(
  Deno.args,
  {
    alias: {
      "s": ["server"],
      "c": ["count"],
      "i": ["interval"],
      "t": ["timeout"],
      "f": ["creds"],
    },
    default: {
      s: "127.0.0.1:4222",
      c: 1,
      i: 0,
      t: 1000,
    },
    boolean: ["debug"],
    string: ["server", "count", "interval", "headers", "creds"],
  },
);

const opts = { servers: argv.s } as ConnectionOptions;
const subject = String(argv._[0]);
const payload = String(argv._[1]) || "";
const count =
  ((argv.c == -1 ? Number.MAX_SAFE_INTEGER : argv.c) || 1) as number;
const interval = (argv.i || 0) as number;

if (argv.debug) {
  opts.debug = true;
}

if (argv.h || argv.help || !subject) {
  console.log(
    "Usage: nats-pub [-s server] [--creds=/path/file.creds] [-c <count>=1] [-t <timeout>=1000] [-i <interval>=0] [--headers] subject [msg]",
  );
  console.log("to request forever, specify -c=-1 or --count=-1");
  Deno.exit(1);
}

if (argv.creds) {
  const data = await Deno.readFile(argv.creds);
  opts.authenticator = credsAuthenticator(data);
}

const nc = await connect(opts);
nc.closed()
  .then((err) => {
    if (err) {
      console.error(`closed with an error: ${err.message}`);
    }
  });

for (let i = 1; i <= count; i++) {
  await nc.request(subject, payload, { timeout: argv.t as number })
    .then((m) => {
      console.log(`[${i}]: ${m.string()}`);
      if (argv.headers && m.headers) {
        const h = [];
        for (const [key, value] of m.headers) {
          h.push(`${key}=${value}`);
        }
        console.log(`\t${h.join(";")}`);
      }
    })
    .catch((err) => {
      console.log(`[${i}]: request failed: ${err.message}`);
    });
  if (interval) {
    await delay(interval);
  }
}
await nc.flush();
await nc.close();
