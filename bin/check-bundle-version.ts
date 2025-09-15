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
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { loadVersions, SemVer } from "./lib/bundle_versions.ts";

// Check that a particular bundle has consistent versions across
// deno.json, package.json, version.ts, and build tag
// the option --fix will pick the best (newest version and use that everywhere)
// --tag (version set by CI in a tag)
// deno run -A check-bundle-versions.ts --module [core|jetstream|kv|obj|transport-node|transport-deno|services] [--tag 1.2.3] [--fix]

async function fixPackageVersion(fp: string, version: SemVer): Promise<void> {
  const d = JSON.parse(await Deno.readTextFile(fp));
  d.version = version.string();
  return Deno.writeTextFile(
    fp,
    JSON.stringify(d, null, 2),
  );
}

async function fixVersionFile(module: string, version: SemVer): Promise<void> {
  await Deno.writeTextFile(
    join(module, "src", "version.ts"),
    `// This file is generated - do not edit
export const version = "${version.string()}";
`,
  );
}

const argv = parseArgs(
  Deno.args,
  {
    alias: {
      "m": ["module"],
      "t": ["tag"],
      "f": ["fix"],
    },
    string: ["module", "tag"],
    boolean: ["fix"],
  },
);

const module = argv.module || null;

if (module === null) {
  console.error(
    `[ERROR] --module is required`,
  );
  Deno.exit(1);
}

const versions = await loadVersions(module);
console.log(versions);

switch (module) {
  case "transport-deno":
    // no node
    if (!versions.deno) {
      console.error(`[ERROR] deno.json for ${module} is missing`);
      Deno.exit(1);
    }
    break;
  case "transport-node":
    if (!versions.node) {
      console.error(`[ERROR] package.json for ${module} is missing`);
      Deno.exit(1);
    }
    break;
  case "core":
    if (!versions.deno) {
      console.error(`[ERROR] deno.json for ${module} is missing`);
      Deno.exit(1);
    }
    if (!versions.node) {
      console.error(`[ERROR] package.json for ${module} is missing`);
      Deno.exit(1);
    }
    if (!versions.file) {
      console.error(`[ERROR] version.json for ${module} is missing`);
      Deno.exit(1);
    }
    break;
  default:
    if (!versions.deno) {
      console.error(`[ERROR] deno.json for ${module} is missing`);
      Deno.exit(1);
    }
    if (!versions.node) {
      console.error(`[ERROR] package.json for ${module} is missing`);
      Deno.exit(1);
    }
}

const version = versions.max()!;

try {
  versions.check();
} catch (_) {
  if (versions.file && version.compare(versions.file) !== 0) {
    if (argv.fix) {
      await fixVersionFile(module, versions.max()!);
      console.error(
        `[OK] fixed src/version.ts file for module ${module}.`,
      );
    } else {
      console.error(
        `[ERROR] src/version.ts file for module ${module} has an inconsistent version.`,
      );
      Deno.exit(1);
    }
  }
  if (versions.node && version.compare(versions.node) !== 0) {
    if (argv.fix) {
      await fixPackageVersion(join(module, "package.json"), versions.max()!);
    } else {
      console.error(
        `[ERROR] package.json file for module ${module} has an inconsistent version.`,
      );
      Deno.exit(1);
    }
  }
  if (versions.deno && version.compare(versions.deno) !== 0) {
    if (argv.fix) {
      await fixPackageVersion(join(module, "deno.json"), versions.max()!);
    } else {
      console.error(
        `[ERROR] deno.json file for module ${module} has an inconsistent version.`,
      );
      Deno.exit(1);
    }
  }
}

if (argv.tag) {
  let tag = argv.tag;
  const prefix = `${argv.module}/`;
  if (tag.startsWith(prefix)) {
    tag = tag.substring(prefix.length);
  }
  if (tag !== version.string()) {
    console.error(
      `[ERROR] expected tag version to match - bundle: ${version!} tag: ${argv.tag}}`,
    );
    Deno.exit(1);
  }
}
console.log(`[OK] ${module} version ${version.string()}`);
Deno.exit(0);
