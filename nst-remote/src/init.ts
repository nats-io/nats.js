/*
 * Copyright 2020-2026 The NATS Authors
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

// Side-effect module: wraps Deno.test to default sanitizeOps and
// sanitizeResources to false, and registers an unload hook that closes the
// shared mgmt/sys NATS connections.
//
// The shared mgmt and sys NATS connections drive async ops across test
// boundaries that the per-test sanitizer would otherwise flag as leaks.

import { closeRemoteContext } from "./server.ts";

// deno-lint-ignore no-explicit-any
const _g = globalThis as any;

if (_g.Deno?.env?.get?.("NST_REMOTE_URL")) {
  _g.addEventListener?.("unload", () => {
    void closeRemoteContext();
  });
  // deno-lint-ignore no-explicit-any
  const denoNs = _g.Deno as any;
  // deno-lint-ignore no-explicit-any
  const orig = denoNs.test as any;
  if (!orig.__nstRemoteWrapped) {
    // deno-lint-ignore no-explicit-any
    const wrap: any = (...args: any[]) => {
      if (typeof args[0] === "string" && typeof args[1] === "function") {
        return orig({
          name: args[0],
          fn: args[1],
          sanitizeOps: false,
          sanitizeResources: false,
        });
      }
      if (typeof args[0] === "function") {
        return orig({
          name: args[0].name,
          fn: args[0],
          sanitizeOps: false,
          sanitizeResources: false,
        });
      }
      if (args[0] && typeof args[0] === "object") {
        return orig({
          sanitizeOps: false,
          sanitizeResources: false,
          ...args[0],
        });
      }
      return orig(...args);
    };
    for (const k of Object.keys(orig)) {
      wrap[k] = orig[k];
    }
    wrap.__nstRemoteWrapped = true;
    denoNs.test = wrap;
  }
}
