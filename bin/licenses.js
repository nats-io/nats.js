import $ from "jsr:@david/dax";
$.setPrintCommand(true);
import checker from "npm:license-checker";

const modules = [
  "core",
  "jetstream",
  "kv",
  "obj",
  "services",
  "transport-node",
];
for (const m of modules) {
  $.cd(`./${m}`);
  await $`npm install`;
  $.cd(`..`);
}

for (const m of modules) {
  let buf = "# Dependencies\n\n";

  buf += "| Dependency | License |\n";
  buf += "| --- | --- |\n";
  checker.init({
    direct: true,
    production: true,
    start: `./${m}`,
  }, async (err, packages) => {
    if (err) {
      throw err;
    }
    for (const b in packages) {
      const module = m === "core" ? "nats-core" : m;
      if (b.startsWith(`@nats-io/${module}`)) {
        // self
        continue;
      }
      const p = packages[b];
      buf += `[${b}](${p?.repository}) | ${p?.licenses} |\n`;
      await Deno.writeTextFile(`./${m}/dependencies.md`, buf);
    }
  });
}
