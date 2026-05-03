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
 * - `"js"` — pure-JS (`js-sha256`). Default. Works in every runtime including
 *   the browser. Slow (~5-10× slower than native at MB+ payloads).
 * - `"native"` — `node:crypto` `createHash`. Built into Node, Deno and Bun
 *   (no extra dependency). Not available in browsers without a polyfill —
 *   selecting `"native"` in a browser bundle will throw at first put/get.
 */
export type Sha256Backend = "js" | "native";

type NodeHash = {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
};

let backend: Sha256Backend = "js";
let factory: (() => StreamingSha256) | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Selects the SHA-256 backend used by Object Store put/get operations.
 * Default is `"js"` (pure-JS, browser-safe). Apps running on Node, Deno or
 * Bun can flip to `"native"` for substantially higher throughput on large
 * objects. The choice is process-wide — call once at startup, before any
 * Object Store operation.
 */
export function setSha256Backend(b: Sha256Backend): void {
  if (b !== "js" && b !== "native") {
    throw new Error(`unknown sha256 backend: ${b}`);
  }
  if (b === backend) return;
  backend = b;
  factory = null;
  initPromise = null;
}

/**
 * Returns the currently selected backend.
 */
export function getSha256Backend(): Sha256Backend {
  return backend;
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

async function init(): Promise<void> {
  if (factory) return;
  if (backend === "native") {
    // indirect specifier — keeps static bundlers from trying to inline this
    const spec = "node:crypto";
    const m = await import(spec) as {
      createHash?: (alg: string) => NodeHash;
    };
    if (typeof m?.createHash !== "function") {
      throw new Error(
        "sha256 backend 'native' selected but `node:crypto` is not available in this runtime",
      );
    }
    const create = m.createHash;
    factory = () => {
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
    return;
  }
  factory = jsFactory;
}

/**
 * Returns a new streaming SHA-256 hasher using the currently selected backend.
 * Resolves the backend lazily on first call after each `setSha256Backend()`.
 */
export async function createSha256(): Promise<StreamingSha256> {
  if (!factory) {
    initPromise = initPromise ?? init();
    await initPromise;
  }
  const f = factory;
  if (!f) {
    // setSha256Backend() was called between await and here; rare race
    throw new Error("sha256 backend reset during init");
  }
  return f();
}
