/*
 * Copyright 2026 The NATS Authors
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

import { sha256 } from "js-sha256";

/**
 * Incremental SHA-256 hasher. Same shape across both backends — output bytes
 * are byte-for-byte identical (verified in `obj/tests/sha256_test.ts`).
 */
export type StreamingSha256 = {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
};

/**
 * SHA-256 backend selector.
 *
 * - `"auto"` — the default: `"native"` when the runtime provides it, `"js"`
 *   otherwise.
 * - `"js"` — pure-JS (`js-sha256`). Works in every runtime including the
 *   browser and React Native. Slow (~5-10× slower than native at MB+
 *   payloads).
 * - `"native"` — `node:crypto` `createHash`, obtained from the runtime with
 *   `process.getBuiltinModule()`: Node (20.16+, 22.3+), Deno and Bun, with no
 *   extra dependency. It isn't imported, so bundles for the browser or React
 *   Native don't reference `node:crypto`. Selecting it where it isn't
 *   available throws at the first put/get.
 */
export type Sha256Backend = "auto" | "js" | "native";

type NodeHash = {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
};

let backend: Sha256Backend = "auto";
let factory: (() => StreamingSha256) | null = null;

/**
 * Selects the SHA-256 backend used by Object Store put/get operations.
 * Default is `"auto"`: `"native"` on Node, Deno or Bun, for substantially
 * higher throughput on large objects, and `"js"` (pure-JS) elsewhere. The
 * choice is process-wide — call once at startup, before any Object Store
 * operation.
 */
export function setSha256Backend(b: Sha256Backend): void {
  if (b !== "auto" && b !== "js" && b !== "native") {
    throw new Error(`unknown sha256 backend: ${b}`);
  }
  if (b === backend) return;
  backend = b;
  factory = null;
}

/**
 * Returns the backend in use: the one selected, or for `"auto"` the one it
 * resolves to in this runtime.
 */
export function getSha256Backend(): "js" | "native" {
  if (backend === "auto") {
    return nodeCreateHash() ? "native" : "js";
  }
  return backend;
}

// node:crypto's createHash, asked of the runtime rather than imported: a
// bundler leaves a function call alone, while it tries to resolve an
// import("node:crypto") even if it never runs - which fails for the browser
// and react native. those don't have process.getBuiltinModule, so it's null
function nodeCreateHash(): ((alg: string) => NodeHash) | null {
  try {
    const p = (globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown };
    }).process;
    const m = p?.getBuiltinModule?.("node:crypto") as
      | { createHash?: (alg: string) => NodeHash }
      | undefined;
    return typeof m?.createHash === "function" ? m.createHash : null;
  } catch {
    return null;
  }
}

function jsFactory(): StreamingSha256 {
  const s = sha256.create();
  return {
    update(data: Uint8Array): void {
      s.update(data);
    },
    digest(): Uint8Array {
      return Uint8Array.from(s.digest());
    },
  };
}

function resolveFactory(): () => StreamingSha256 {
  if (backend === "js") {
    return jsFactory;
  }
  const create = nodeCreateHash();
  if (!create) {
    if (backend === "native") {
      throw new Error(
        "sha256 backend 'native' selected but `node:crypto` is not available in this runtime",
      );
    }
    return jsFactory;
  }
  return () => {
    const h = create("sha256");
    return {
      update(data: Uint8Array): void {
        h.update(data);
      },
      digest(): Uint8Array {
        return new Uint8Array(h.digest());
      },
    };
  };
}

/**
 * Returns a new streaming SHA-256 hasher using the currently selected backend.
 * Resolves the backend on first call after each `setSha256Backend()`.
 */
export function createSha256(): Promise<StreamingSha256> {
  try {
    factory = factory ?? resolveFactory();
    return Promise.resolve(factory());
  } catch (err) {
    return Promise.reject(err);
  }
}
