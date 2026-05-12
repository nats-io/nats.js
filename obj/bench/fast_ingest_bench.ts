/*
 * obj store fast-ingest benchmark.
 *
 * spawns a local nats-server with jetstream + memory storage, puts <size>
 * bytes into two buckets — one with fast ingest disabled, one with it
 * enabled — and prints throughput for each. not part of the test suite;
 * run manually:
 *
 *   deno run -A obj/bench/fast_ingest_bench.ts [--size 1G] [--chunk 1M]
 *
 * requires nats-server 2.14+ on PATH (so api_lvl >= 4 → fast ingest path).
 */

import { jetstreamServerConf, NatsServer } from "nst";
import { connect } from "../tests/connect.ts";
import { Objm } from "../src/objectstore.ts";
import { StorageType } from "../src/types.ts";
import { setSha256Backend, type Sha256Backend } from "../src/sha256.ts";

type Args = { size: number; chunk: number };

function parseSize(s: string): number {
  const m = s.trim().toUpperCase().match(/^(\d+)(B|K|KB|M|MB|G|GB)?$/);
  if (!m) throw new Error(`bad size: ${s}`);
  const n = parseInt(m[1], 10);
  const u = (m[2] ?? "B").replace(/KB?/, "K").replace(/MB?/, "M").replace(
    /GB?/,
    "G",
  );
  switch (u) {
    case "B":
      return n;
    case "K":
      return n * 1024;
    case "M":
      return n * 1024 * 1024;
    case "G":
      return n * 1024 * 1024 * 1024;
  }
  throw new Error(`bad unit: ${u}`);
}

function parseArgs(): Args {
  const args = Deno.args;
  let size = 1024 * 1024 * 1024; // 1G default
  let chunk = 1024 * 1024; // 1M default pull chunk
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--size") size = parseSize(args[++i]);
    else if (args[i] === "--chunk") chunk = parseSize(args[++i]);
  }
  return { size, chunk };
}

function fmtBytes(n: number): string {
  const u = ["B", "KiB", "MiB", "GiB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(2)} ${u[i]}`;
}

// streams `total` bytes of pattern data in `chunk`-sized pieces. avoids a
// single big allocation. one shared buffer, reused per pull.
function patternStream(
  total: number,
  chunk: number,
): ReadableStream<Uint8Array> {
  let sent = 0;
  const buf = new Uint8Array(chunk);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31) & 0xff;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const remaining = total - sent;
      if (remaining >= chunk) {
        // important: enqueue a copy or a fresh slice — re-enqueuing the
        // same buffer would be detached after transfer in some runtimes.
        controller.enqueue(buf.slice(0));
        sent += chunk;
      } else {
        controller.enqueue(buf.slice(0, remaining));
        sent += remaining;
      }
    },
  });
}

async function runBench(
  label: string,
  bucket: string,
  sha: Sha256Backend,
  disableFastIngest: boolean,
  args: Args,
  port: number,
): Promise<void> {
  setSha256Backend(sha);
  const nc = await connect({ port });
  const objm = new Objm(nc);
  const os = await objm.create(bucket, {
    storage: StorageType.Memory,
    max_bytes: args.size + 64 * 1024 * 1024,
    disableFastIngest,
  });

  const stream = patternStream(args.size, args.chunk);
  const start = performance.now();
  const oi = await os.put({ name: "blob" }, stream);
  const elapsed = (performance.now() - start) / 1000;
  const throughput = args.size / elapsed;

  console.log(
    `${label.padEnd(36)} ${fmtBytes(args.size)} in ${elapsed.toFixed(2)}s ` +
      `→ ${fmtBytes(throughput)}/s ` +
      `chunks=${oi.chunks}`,
  );

  // free server memory before next bench
  await os.destroy();
  await nc.close();
}

async function main() {
  const args = parseArgs();
  console.log(
    `bench: putting ${fmtBytes(args.size)} per bucket, ` +
      `pull-chunk=${fmtBytes(args.chunk)}`,
  );

  const ns = await NatsServer.start(
    jetstreamServerConf({
      jetstream: {
        max_mem_store: args.size * 4,
        max_file_store: args.size * 4,
      },
    }),
  );

  // 2x2 matrix: {js | native sha} x {legacy publish | fast ingest}
  try {
    await runBench("js-sha + legacy publish", "b1", "js", true, args, ns.port);
    await runBench("js-sha + fast ingest", "b2", "js", false, args, ns.port);
    await runBench(
      "native-sha + legacy publish",
      "b3",
      "native",
      true,
      args,
      ns.port,
    );
    await runBench(
      "native-sha + fast ingest",
      "b4",
      "native",
      false,
      args,
      ns.port,
    );
  } finally {
    await ns.stop();
  }
}

await main();
