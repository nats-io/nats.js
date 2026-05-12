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

// Shared helpers for the cluster.ts / chaos_client.ts TUI dashboards.

import {
  blue,
  cyan,
  green,
  magenta,
  red,
  white,
  yellow,
} from "@std/fmt/colors";

export const MAX_WIDTH = 80;
export const CLEAR_HOME = "\x1b[H\x1b[2J";

export const palette: Array<(s: string) => string> = [
  cyan,
  magenta,
  yellow,
  green,
  blue,
  red,
  white,
];

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
}

/**
 * Returns a coalescing scheduler that calls `fn` once per microtask
 * regardless of how many times schedule() was invoked. Used to batch
 * burst event-driven redraws.
 */
export function coalescingScheduler(fn: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      fn();
    });
  };
}

const encoder = new TextEncoder();

export function writeFrame(out: string): void {
  Deno.stdout.writeSync(encoder.encode(CLEAR_HOME + out + "\n"));
}

export function clearScreen(): void {
  Deno.stdout.writeSync(encoder.encode(CLEAR_HOME));
}
