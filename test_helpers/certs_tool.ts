import { parseArgs } from "@std/cli";
import { Certs } from "./certs.ts";

// this tool packs a bunch of certs into a JSON file keyed after its name
const argv = parseArgs(Deno.args, {
  alias: {
    "d": ["dir"],
    "o": ["out"],
    "i": ["in"],
    boolean: ["force"],
  },
});

if (argv.h || argv.help) {
  console.log(
    "usage: cert --dir dir --out|--in json",
  );
  Deno.exit(0);
}

const dir = argv["dir"];
const outFile = argv["out"];
const inFile = argv["in"];

if (!dir) {
  console.log("--dir is required");
  Deno.exit(1);
}

if (outFile) {
  const certs = await Certs.fromDir(dir);
  await certs.save(outFile);
} else if (inFile) {
  const certs = await Certs.fromFile(inFile);
  await certs.store(dir);
}
