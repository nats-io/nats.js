#!/usr/bin/env deno run --allow-all --unstable

import { parse } from "@std/flags";
import { connect, type ConnectionOptions } from "@nats-io/transport-deno";

const argv = parse(
  Deno.args,
  {
    alias: {
      "s": ["server"],
    },
    default: {
      s: "127.0.0.1:4222",
    },
  },
);

const opts = { servers: argv.s } as ConnectionOptions;

const nc = await connect(opts);
(async () => {
  console.info(`connected ${nc.getServer()}`);
  for await (const s of nc.status()) {
    console.info(s);
  }
})().then();

await nc.closed()
  .then((err) => {
    if (err) {
      console.error(`closed with an error: ${(err as Error).message}`);
    }
  });
