/*
 * Copyright 2024 The NATS Authors
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

#!/usr/bin/env -S deno run -A
import { parseArgs } from "jsr:@std/cli/parse-args";
import { join } from "jsr:@std/path";

class ModuleVersions {
  file?: SemVer;
  deno?: SemVer;
  node?: SemVer;

  constructor() {
  }

  max(): SemVer | null {
    const vers = this.versions();
    let vv: SemVer | null = null;
    vers.forEach((v) => {
      vv = vv == null ? v : vv.max(v);
    });
    return vv;
  }

  versions(): SemVer[] {
    const vers = [];
    if (this.file) {
      vers.push(this.file);
    }
    if (this.deno) {
      vers.push(this.deno);
    }
    if (this.node) {
      vers.push(this.node);
    }
    return vers;
  }

  check() {
    const m = this.max();
    if (m !== null) {
      this.versions().forEach((v) => {
        if (m.compare(v) !== 0) {
          throw new Error("different versions found");
        }
      });
    }
  }
}

class SemVer {
  major: number;
  minor: number;
  micro: number;
  qualifier: string;

  constructor(v: string) {
    const m = v.match(/(\d+).(\d+).(\d+)(-{1}(.+))?/);
    if (m) {
      this.major = parseInt(m[1]);
      this.minor = parseInt(m[2]);
      this.micro = parseInt(m[3]);
      this.qualifier = m[5] ? m[5] : "";
    } else {
      throw new Error(`'${v}' is not a semver value`);
    }
  }

  compare(b: SemVer): number {
    if (this.major < b.major) return -1;
    if (this.major > b.major) return 1;
    if (this.minor < b.minor) return -1;
    if (this.minor > b.minor) return 1;
    if (this.micro < b.micro) return -1;
    if (this.micro > b.micro) return 1;
    if (this.qualifier === "") return 1;
    if (b.qualifier === "") return -1;
    return this.qualifier.localeCompare(b.qualifier);
  }

  max(b: SemVer): SemVer {
    return this.compare(b) > 0 ? this : b;
  }

  string(): string {
    return `${this.major}.${this.minor}.${this.micro}` +
      (this.qualifier ? `-${this.qualifier}` : "");
  }
}

async function loadVersionFile(module: string): Promise<string> {
  const { version } = await import(
    join(Deno.cwd(), module, "src", "version.ts")
  ).catch(() => {
    return "";
  });
  return version;
}

async function loadPackageFile(fp: string): Promise<{ version: string }> {
  const src = await Deno.readTextFile(fp)
    .catch(() => {
      return JSON.stringify({ version: "" });
    });
  return JSON.parse(src);
}

async function loadVersions(module: string): Promise<ModuleVersions> {
  const v = new ModuleVersions();
  const file = await loadVersionFile(module);
  if (file) {
    v.file = new SemVer(file);
  }

  const { version: deno } = await loadPackageFile(
    join(Deno.cwd(), module, "deno.json"),
  );
  if (deno) {
    v.deno = new SemVer(deno);
  }

  const { version: node } = await loadPackageFile(
    join(Deno.cwd(), module, "package.json"),
  );
  if (node) {
    v.node = new SemVer(node);
  }
  return v;
}

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
