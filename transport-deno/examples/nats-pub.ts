#!/usr/bin/env deno run --allow-all --unstable

import { parse } from "jsr:@std/flags";
import {
  connect,
  type ConnectionOptions,
  credsAuthenticator,
  delay,
  headers,
  type MsgHdrs,
} from "jsr:@nats-io/transport-deno@3.0.0-24";

const argv = parse(
  Deno.args,
  {
    alias: {
      "s": ["server"],
      "c": ["count"],
      "i": ["interval"],
      "f": ["creds"],
    },
    default: {
      s: "127.0.0.1:4222",
      c: 1,
      i: 0,
    },
    boolean: ["debug"],
    string: ["server", "count", "interval", "headers", "creds"],
  },
);

const copts = { servers: argv.s } as ConnectionOptions;
const subject = String(argv._[0]);
const payload = (argv._[1] || "") as string;
const count =
  ((argv.c == -1 ? Number.MAX_SAFE_INTEGER : argv.c) || 1) as number;
const interval = (argv.i || 0) as number;

if (argv.debug) {
  copts.debug = true;
}

if (argv.h || argv.help || !subject) {
  console.log(
    "Usage: nats-pub [-s server] [--creds=/path/file.creds] [-c <count>=1] [-i <interval>=0] [--headers='k=v;k2=v2'] subject [msg]",
  );
  console.log("to publish forever, specify -c=-1 or --count=-1");
  Deno.exit(1);
}

if (argv.creds) {
  const data = await Deno.readFile(argv.creds);
  copts.authenticator = credsAuthenticator(data);
}

const nc = await connect(copts);
nc.closed()
  .then((err) => {
    if (err) {
      console.error(`closed with an error: ${err.message}`);
    }
  });

const pubopts = {} as { reply?: string; headers?: MsgHdrs };
if (argv.headers) {
  const hdrs = headers();
  argv.headers.split(";").map((l: string) => {
    const [k, v] = l.split("=");
    hdrs.append(k, v);
  });
  pubopts.headers = hdrs;
}

for (let i = 1; i <= count; i++) {
  let d = payload;
  if (d === "") {
    d = `${i}`;
  }
  nc.publish(subject, d, pubopts);
  console.log(`[${i}] ${subject}: ${d}`);
  if (interval) {
    await delay(interval);
  }
}
await nc.flush();
await nc.close();
