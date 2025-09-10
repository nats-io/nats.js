#!/usr/bin/env deno run --allow-all --unstable

import { parse } from "@std/flags";
import {
  connect,
  type ConnectionOptions,
  credsAuthenticator,
} from "@nats-io/transport-deno";

const argv = parse(
  Deno.args,
  {
    alias: {
      "s": ["server"],
      "q": ["queue"],
      "f": ["creds"],
    },
    default: {
      s: "127.0.0.1:4222",
      q: "",
    },
    boolean: ["headers", "debug"],
    string: ["server", "queue", "creds"],
  },
);

const opts = { servers: argv.s } as ConnectionOptions;
const subject = argv._[0] ? String(argv._[0]) : ">";

if (argv.debug) {
  opts.debug = true;
}

if (argv.creds) {
  const data = await Deno.readFile(argv.creds);
  opts.authenticator = credsAuthenticator(data);
}

if (argv.h || argv.help || !subject) {
  console.log(
    "Usage: nats-sub [-s server]  [--creds=/path/file.creds] [-q queue] [--headers] subject",
  );
  Deno.exit(1);
}

const nc = await connect(opts);
console.info(`connected ${nc.getServer()}`);
nc.closed()
  .then((err) => {
    if (err) {
      console.error(`closed with an error: ${err.message}`);
    }
  });

const sub = nc.subscribe(subject, { queue: argv.q as string });
console.info(`${argv.q !== "" ? "queue " : ""}listening to ${subject}`);
for await (const m of sub) {
  console.log(`[${sub.getProcessed()}]: ${m.subject}: ${m.string()}`);
  if (argv.headers && m.headers) {
    const h = [];
    for (const [key, value] of m.headers) {
      h.push(`${key}=${value}`);
    }
    console.log(`\t${h.join(";")}`);
  }
}
