/*
 * Copyright 2024-2026 The NATS Authors
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
import { spawn } from "node:child_process";
import process from "node:process";

export interface SpawnedProc {
  pid: number;
  onStderr(cb: (chunk: Uint8Array) => void): void;
  closeStderr(): Promise<void>;
  kill(signal: string): boolean;
  exited(): Promise<void>;
}

interface DenoChild {
  pid: number;
  stderr: ReadableStream<Uint8Array>;
  status: Promise<unknown>;
  kill(signal: string): void;
}

declare const Deno: {
  Command: new (cmd: string, opts: unknown) => { spawn: () => DenoChild };
};

export function spawnServer(exe: string, args: string[]): SpawnedProc {
  if (typeof Deno !== "undefined" && typeof Deno.Command === "function") {
    return spawnDeno(exe, args);
  }
  return spawnNode(exe, args);
}

function spawnDeno(exe: string, args: string[]): SpawnedProc {
  const cmd = new Deno.Command(exe, {
    args,
    stderr: "piped",
    stdout: "null",
    stdin: "null",
  });
  const child = cmd.spawn();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let loopDone: Promise<void> = Promise.resolve();
  return {
    pid: child.pid,
    onStderr(cb) {
      reader?.cancel().catch(() => {});
      const r = child.stderr.getReader();
      reader = r;
      loopDone = (async () => {
        while (true) {
          try {
            const res = await r.read();
            if (res.done) break;
            if (res.value) cb(res.value);
          } catch (_) {
            break;
          }
        }
      })();
    },
    closeStderr() {
      reader?.cancel().catch(() => {});
      reader = null;
      return Promise.resolve();
    },
    kill(signal) {
      try {
        child.kill(signal);
        return true;
      } catch (_) {
        return false;
      }
    },
    async exited() {
      await child.status;
      await loopDone;
    },
  };
}

function spawnNode(exe: string, args: string[]): SpawnedProc {
  const child = spawn(exe, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let exitResolve!: () => void;
  let exitReject!: (err: Error) => void;
  const exited = new Promise<void>((res, rej) => {
    exitResolve = res;
    exitReject = rej;
  });
  child.once("exit", () => {
    child.stderr?.removeAllListeners();
    child.stderr?.destroy();
    exitResolve();
  });
  child.once("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      exitReject(
        new Error(
          `nats-server not found on PATH (tried "${exe}"). Install: https://github.com/nats-io/nats-server/releases`,
        ),
      );
      return;
    }
    exitReject(err);
  });
  return {
    pid: child.pid ?? -1,
    onStderr(cb) {
      // deno-lint-ignore no-explicit-any
      child.stderr?.on("data", (chunk: any) => cb(new Uint8Array(chunk)));
    },
    closeStderr() {
      child.stderr?.removeAllListeners();
      child.stderr?.destroy();
      return Promise.resolve();
    },
    kill(signal) {
      if (child.pid) {
        try {
          process.kill(child.pid, signal as NodeJS.Signals);
          return true;
        } catch (_) {
          return false;
        }
      }
      return false;
    },
    exited() {
      return exited;
    },
  };
}
