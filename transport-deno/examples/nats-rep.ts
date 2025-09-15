#!/usr/bin/env deno run --allow-all --unstable

import { parse } from "@std/flags";
import {
  connect,
  type ConnectionOptions,
  credsAuthenticator,
  headers,
} from "@nats-io/transport-deno";

const argv = parse(
  Deno.args,
  {
    alias: {
      "s": ["server"],
      "q": ["queue"],
      "e": ["echo"],
      "f": ["creds"],
    },
    default: {
      s: "127.0.0.1:4222",
      q: "",
    },
    boolean: ["echo", "headers", "debug"],
    string: ["server", "queue", "creds"],
  },
);

const opts = { servers: argv.s } as ConnectionOptions;
const subject = argv._[0] ? String(argv._[0]) : "";
const payload = (argv._[1] || "") as string;

if (argv.debug) {
  opts.debug = true;
}

if (argv.h || argv.help || !subject) {
  console.log(
    "Usage: nats-rep [-s server] [--creds=/path/file.creds] [-q queue] [--headers] [-e echo_payload] subject [payload]",
  );
  Deno.exit(1);
}

if (argv.creds) {
  const data = await Deno.readFile(argv.creds);
  opts.authenticator = credsAuthenticator(data);
}

const nc = await connect(opts);
console.info(`connected ${nc.getServer()}`);
nc.closed()
  .then((err) => {
    if (err) {
      console.error(`closed with an error: ${err.message}`);
    }
  });

const hdrs = argv.headers ? headers() : undefined;

const queue = argv.q as string;
const sub = nc.subscribe(subject, { queue });
console.info(`${queue !== "" ? "queue " : ""}listening to ${subject}`);
for await (const m of sub) {
  if (hdrs) {
    hdrs.set("sequence", sub.getProcessed().toString());
    hdrs.set("time", Date.now().toString());
  }
  if (m.respond(argv.e ? m.data : payload, { headers: hdrs })) {
    console.log(`[${sub.getProcessed()}]: ${m.reply}: ${m.string()}`);
  } else {
    console.log(`[${sub.getProcessed()}]: ignored - no reply subject`);
  }
}
