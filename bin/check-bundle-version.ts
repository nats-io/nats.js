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

async function load(fp: string): Promise<string> {
  const src = await Deno.readTextFile(fp);
  const { version } = JSON.parse(src);
  return version;
}

const argv = parseArgs(
  Deno.args,
  {
    alias: {
      "m": ["module"],
      "t": ["tag"],
    },
    string: ["module", "tag"],
  },
);

const module = argv.module || null;

if (module === null) {
  console.error(
    `[ERROR] --module is required`,
  );
  Deno.exit(1);
}

let version: string;

if (module.startsWith("transport-")) {
  let packageVersion: string = "";
  const versionFile = await load(join(module, "src", "version.json"));
  switch (module) {
    case "transport-node":
      packageVersion = await load(join(module, "package.json"));
      break;
    default:
      packageVersion = await load(join(module, "deno.json"));
      break;
  }
  if (!packageVersion) {
    console.error(
      `[ERROR] package version for module ${module} is missing a version`,
    );
    Deno.exit(1);
  }
  if (!versionFile) {
    console.error(
      `[ERROR] src/version.json file for module ${module} is missing a version`,
    );
    Deno.exit(1);
  }
  if (packageVersion !== versionFile) {
    console.error(
      `[ERROR] expected versions to match - package: ${packageVersion} src/version.json: ${versionFile}`,
    );
    Deno.exit(1);
  }
  version = versionFile;
} else {
  const deno = await load(join(module, "deno.json"));
  const node = await load(join(module, "package.json"));

  if (deno !== node) {
    console.error(
      `[ERROR] expected versions to match - deno.json: ${deno} package.json: ${node}`,
    );
    Deno.exit(1);
  }
  version = deno;
}

if (argv.tag) {
  let tag = argv.tag;
  const prefix = `${argv.module}/`;
  if (tag.startsWith(prefix)) {
    tag = tag.substring(prefix.length);
  }
  if (tag !== version) {
    console.error(
      `[ERROR] expected tag version to match - bundle: ${version} tag: ${argv.tag}}`,
    );
    Deno.exit(1);
  }
}

Deno.exit(0);
