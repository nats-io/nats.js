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
const { VERSION } = JSON.parse(await Deno.readTextFile("src/version.json"));

const pkg = await Deno.readTextFile("package.json");
const m = JSON.parse(pkg);
if (m.version !== VERSION) {
  console.error(
    `[ERROR] expected package version ${m.version} and transport version ${VERSION} to match`,
  );
  Deno.exit(1);
} else {
  console.info(
    `[OK] package version and transport version match ${m.version}`,
  );
}

let tag = Deno.env.get("RELEASE_VERSION");
if (tag) {
  if (tag.startsWith("v")) {
    tag = tag.substring(1);
  }

  if (m.version !== tag) {
    console.error(
      `[ERROR] expected RELEASE_VERSION and package versions to match ${tag} !== ${m.version}`,
    );
    Deno.exit(1);
  }
  console.log(`[OK] RELEASE_VERSION and package versions match ${tag}`);
} else {
  console.log(`[SKIP] tag check`);
}

Deno.exit(0);
