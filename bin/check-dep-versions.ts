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

// this command checks that bundles dependencies have a minimum floor dependency
// matching the current version of a bundle. This way the next release
// raises the minimum version of the dependency to currently released versions
// of the dependency.

import { join } from "@std/path";
import { loadPackageFile, SemVer } from "./lib/bundle_versions.ts";

type PackageJSON = {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
type DenoJSON = {
  name: string;
  version: string;
  imports: Record<string, string>;
};
type Imports = {
  imports: Record<string, string>;
};

class ImportMap {
  data: Imports;
  changed: boolean;

  constructor(data: Imports) {
    this.data = data;
    this.changed = false;
  }
  static async load(dir: string): Promise<ImportMap | null> {
    const data = await loadPackageFile<Imports>(
      join(dir, "import_map.json"),
    );

    if (data.imports) {
      return new ImportMap(data);
    }

    return null;
  }

  has(module: string): SemVer | null {
    if (this.data.imports) {
      const v = this.data.imports[module];
      // we only update them when they have a jsr - otherwise it is local file
      if (v?.startsWith("jsr:")) {
        return DenoModule.parseVersion(
          this.data.imports[module],
        );
      }
    }
    return null;
  }

  update(module: string, version: SemVer): boolean {
    let changed = false;
    if (this.data.imports) {
      const have = this.has(module);
      if (have && version.compare(have) !== 0) {
        this.data.imports[module] = `jsr:${module}@${version.string()}`;
        changed = true;
      }
      const internalModule = `${module}/internal`;
      const haveInternal = this.has(internalModule);
      if (haveInternal && version.compare(haveInternal) !== 0) {
        this.data.imports[internalModule] =
          `jsr:${module}@${version.string()}/internal`;
        changed = true;
      }
      return changed;
    }
    return false;
  }

  store(dir: string): Promise<void> {
    this.changed = false;
    return Deno.writeTextFile(
      join(dir, "import_map.json"),
      JSON.stringify(this.data, null, 2),
    );
  }
}

class BaseModule {
  name: string;
  version: SemVer;

  constructor(name: string, version: SemVer) {
    this.name = name;
    this.version = version;
  }
}

class DenoModule extends BaseModule {
  data: DenoJSON;
  changed: boolean;

  constructor(name: string, version: SemVer, data: DenoJSON) {
    super(name, version);
    this.data = data;
    this.changed = false;
  }

  static async load(dir: string): Promise<DenoModule | null> {
    const data = await loadPackageFile<DenoJSON>(
      join(dir, "deno.json"),
    );

    if (data.version) {
      return new DenoModule(data.name, new SemVer(data.version), data);
    }

    return null;
  }

  store(dir: string): Promise<void> {
    this.changed = false;
    return Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify(this.data, null, 2),
    );
  }

  has(module: string): SemVer | null {
    if (this.data.imports) {
      return DenoModule.parseVersion(
        this.data.imports[module],
      );
    }
    return null;
  }

  update(module: string, version: SemVer): boolean {
    if (this.data.imports) {
      const have = this.has(module);
      if (have && version.compare(have) !== 0) {
        this.data.imports[module] = `jsr:${module}@${version.string()}`;
        this.changed = true;
        return true;
      }
    }
    return false;
  }

  static parseVersion(v: string): SemVer | null {
    // jsr:@nats-io/something@[^|~]0.0.0-something
    if (v) {
      v = v.substring(v.lastIndexOf("@"));
      return v.startsWith("^") || v.startsWith("~")
        ? new SemVer(v.substring(1))
        : new SemVer(v);
    }
    return null;
  }
}

class NodeModule extends BaseModule {
  data: PackageJSON;
  changed: boolean;

  constructor(name: string, version: SemVer) {
    super(name, version);
    this.data = {} as PackageJSON;
    this.changed = false;
  }

  static async load(dir: string): Promise<NodeModule | null> {
    const packageJSON = await loadPackageFile<PackageJSON>(
      join(dir, "package.json"),
    );

    if (packageJSON.version) {
      const m = new NodeModule(
        packageJSON.name,
        new SemVer(packageJSON.version),
      );
      m.data = packageJSON;
      return m;
    }

    return null;
  }

  has(module: string): SemVer | null {
    if (this.data.dependencies) {
      return NodeModule.parseVersion(
        this.data.dependencies[module],
      );
    }
    return null;
  }

  hasDev(module: string): SemVer | null {
    if (this.data.devDependencies) {
      return NodeModule.parseVersion(
        this.data.devDependencies[module],
      );
    }
    return null;
  }

  static parseVersion(v: string): SemVer | null {
    if (v) {
      return v.startsWith("^") || v.startsWith("~")
        ? new SemVer(v.substring(1))
        : new SemVer(v);
    }
    return null;
  }

  update(module: string, version: SemVer): boolean {
    if (this.data.dependencies) {
      const have = this.has(module);
      if (have && version.compare(have) !== 0) {
        let prefix = this.data.dependencies[module].charAt(0);
        if (prefix !== "^" && prefix !== "~") {
          prefix = "";
        }
        this.data.dependencies[module] = `${prefix}${version.string()}`;
        this.changed = true;
      }
    }
    if (this.data.devDependencies) {
      const have = this.hasDev(module);
      if (have && version.compare(have) !== 0) {
        let prefix = this.data.devDependencies[module].charAt(0);
        if (prefix !== "^" && prefix !== "~") {
          prefix = "";
        }
        this.data.devDependencies[module] = `${prefix}${version.string()}`;
        this.changed = true;
      }
    }
    return this.changed;
  }

  store(dir: string): Promise<void> {
    this.changed = false;
    return Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify(this.data, null, 2),
    );
  }
}

const dirs = [
  "core",
  "services",
  "jetstream",
  "kv",
  "obj",
  "transport-deno",
  "transport-node",
];

let nuid = new SemVer("0.0.0");
let nkeys = new SemVer("0.0.0");

for (const dir of dirs) {
  const dm = await DenoModule.load(dir);
  const nm = await NodeModule.load(dir);

  if (dm && nm) {
    if (dm.version.compare(nm.version) !== 0) {
      throw new Error(
        `expected package.json and deno.json to match for ${dir}`,
      );
    }
  }

  const v = dm ? dm.version : nm!.version;
  const moduleName = dm ? dm.name : nm!.name;

  const other = dirs.filter((m) => {
    return m !== dir;
  });

  for (const d of other) {
    const dmm = await DenoModule.load(d);
    if (dmm) {
      if (dmm.has(moduleName)) {
        dmm.update(moduleName, v);
        await dmm.store(d);
      }

      const onuid = dmm.has("@nats-io/nuid");
      if (onuid) {
        nuid = nuid.max(onuid);
      }
      const onkeys = dmm.has("@nats-io/nkeys");
      if (onkeys) {
        nkeys = nkeys.max(onkeys);
      }
    }
    const nmm = await NodeModule.load(d);
    if (nmm) {
      if (nmm.has(moduleName) || nmm.hasDev(moduleName)) {
        nmm.update(moduleName, v);
        await nmm.store(d);
      }
      const onuid = nmm.has("@nats-io/nuid") || nmm.hasDev("@nats-io/nuid");
      if (onuid) {
        nuid = nuid.max(onuid);
      }
      const onkeys = nmm.has("@nats-io/nkeys") || nmm.hasDev("@nats-io/nkeys");
      if (onkeys) {
        nkeys = nkeys.max(onkeys);
      }
    }

    const map = await ImportMap.load(d);
    if (map) {
      if (map.has(moduleName)) {
        map.update(moduleName, v);
        await map.store(d);
      }
    }
  }
}

for (const d of dirs) {
  const dmm = await DenoModule.load(d);
  if (dmm) {
    if (dmm.has("@nats-io/nuid")) {
      dmm.update("@nats-io/nuid", nuid);
      await dmm.store(d);
    }
    if (dmm.has("@nats-io/nkeys")) {
      dmm.update("@nats-io/nkeys", nkeys);
      await dmm.store(d);
    }
  }
  const nmm = await NodeModule.load(d);
  if (nmm) {
    if (nmm.has("@nats-io/nuid")) {
      nmm.update("@nats-io/nuid", nuid);
      await nmm.store(d);
    }
    if (nmm.has("@nats-io/nkeys")) {
      nmm.update("@nats-io/nkeys", nkeys);
      await nmm.store(d);
    }
  }

  const map = await ImportMap.load(d);
  if (map) {
    if (map.has("@nats-io/nuid")) {
      map.update("@nats-io/nuid", nuid);
      await map.store(d);
    }
    if (map.has("@nats-io/nkeys")) {
      map.update("@nats-io/nkeys", nkeys);
      await map.store(d);
    }
  }
}
