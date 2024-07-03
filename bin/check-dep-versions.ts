#!/usr/bin/env -S deno run -A
/*
 * Copyright 2021-2024 The NATS Authors
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

import { parseArgs } from "jsr:@std/cli/parse-args";
import { join } from "jsr:@std/path";

async function load<T>(fp: string): Promise<T> {
  const src = await Deno.readTextFile(fp);
  return JSON.parse(src);
}

type denoImports = {
  imports: Record<string, string>;
};

type nodeDependencies = {
  dependencies: Record<string, string>;
};

const argv = parseArgs(
  Deno.args,
  {
    alias: {
      "m": ["module"],
      "v": ["verbose"],
      "f": ["fix"],
    },
    string: ["module"],
    boolean: ["v", "f"],
  },
);

const module = argv.module || null;

if (module === null) {
  console.error(
    `[ERROR] --module is required`,
  );
  Deno.exit(1);
}

const di = await load<denoImports>(join(module, "deno.json"));
const nd = await load<nodeDependencies>(join(module, "package.json"));

// drive the dependencies from the deno.json, as npm may contain additional ones
let failed = false;
let fixed = false;

for (const lib in di.imports) {
  let deno = di.imports[lib];
  const prefix = `jsr:${lib}@`;
  if (deno.startsWith(prefix)) {
    deno = deno.substring(prefix.length);
  }

  if (argv.f) {
    if (nd.dependencies[lib] !== deno) {
      console.log(
        `changed in package.json ${lib} from ${
          nd.dependencies[lib]
        } to ${deno}`,
      );
      nd.dependencies[lib] = deno;
      fixed = true;
    }
    continue;
  }

  if (argv.v === true) {
    const node = nd.dependencies[lib];
    console.log({ lib, deno, node });
  }
  if (!nd.dependencies[lib]) {
    failed = true;
    console.log(
      `[ERROR] module ${module} package.json dependencies is missing: ${lib}`,
    );
    continue;
  }
  if (deno !== nd.dependencies[lib]) {
    failed = true;
    console.log(
      `[ERROR] module ${module} package.json dependencies ${lib}: ${
        nd.dependencies[lib]
      } - but should be ${deno}`,
    );
  }
}

if (argv.f && fixed) {
  await Deno.writeTextFile(
    join(module, "package.json"),
    JSON.stringify(nd, undefined, " "),
  );
  console.log(`[OK] module ${module} updated package.json`);
  Deno.exit(0);
}

if (failed) {
  Deno.exit(1);
}
console.log(`[OK] module ${module}`);
Deno.exit(0);
