/*
 * Copyright 2023 The NATS Authors
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

import { extname, join, resolve } from "@std/path";

// resolve the specified directories to fq
// let dirs = ["src", "nats-base-client", "jetstream", "bin"].map((n) => {
const dirs = ["."].map((n) => {
  return resolve(n);
});

// collect a list of all the files
const files: string[] = [];
for (const d of dirs) {
  for await (const fn of Deno.readDir(d)) {
    // expand nested dirs
    if (fn.isDirectory) {
      dirs.push(join(d, fn.name));
      continue;
    } else if (fn.isFile) {
      const ext = extname(fn.name);
      if (ext === ".ts" || ext === ".js") {
        files.push(join(d, fn.name));
      }
    }
  }
}

const m = new Map<string, string[]>();

// process each file - remove extensions from requires/import
for (const fn of files) {
  const data = await Deno.readFile(fn);
  const txt = new TextDecoder().decode(data);
  const iter = txt.matchAll(/from\s+"(\S+.[t|j]s)"/gim);
  for (const s of iter) {
    let dep = s[1];
    if (dep.startsWith(`./`) || dep.startsWith(`../`)) {
      // this is local code
      continue;
    }
    if (dep.includes("nats-io/nats.deno")) {
      // self dep
      continue;
    }
    if (dep.includes("deno.land/x/nats@")) {
      // this is self-reference
      continue;
    }
    if (dep.includes("https://deno.land/x/nkeys.js@")) {
      dep = "https://github.com/nats-io/nkeys.js";
    }
    if (dep.includes("nats-io/nkeys.js")) {
      dep = "https://github.com/nats-io/nkeys.js";
    }
    if (dep.includes("nats-io/jwt.js")) {
      dep = "https://github.com/nats-io/jwt.js";
    }
    if (dep.includes("deno.land/x/cobra@")) {
      dep = "https://deno.land/x/cobra/mod.ts";
    }
    if (dep.includes("deno.land/x/cobra/")) {
      dep = "https://deno.land/x/cobra/mod.ts";
    }
    if (dep.includes("deno.land/std@")) {
      dep = "https://github.com/denoland/deno_std";
    }

    if (dep.includes("chiefbiiko/sha256")) {
      dep = "https://github.com/chiefbiiko/sha256";
    }
    let v = m.get(dep);
    if (!v) {
      v = [];
    }
    v.push(fn);
    m.set(dep, v);
  }
}

const keys = Array.from(m.keys()).sort();
for (const k of keys) {
  console.log(k);
  const v = m.get(k);
  for (const f of v!) {
    console.log(`\t${f}`);
  }
}
