/*
 * Copyright 2024 Synadia Communications, Inc
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

import { delay } from "@nats-io/nats-core";
import type { Consumer, Stream } from "../src/types.ts";
import { fail } from "@std/assert";
import { StreamImpl } from "../src/jsmstream_api.ts";
import { ConsumerNotFoundError, StreamNotFoundError } from "../src/jserrors.ts";

export function stripNatsMetadata(md?: Record<string, string>) {
  if (md) {
    for (const p in md) {
      if (p.startsWith("_nats.")) {
        delete md[p];
      }
    }
  }
}

export async function delayUntilAssetNotFound(
  a: Consumer | Stream,
): Promise<void> {
  const expected = a instanceof StreamImpl ? "stream" : "consumer";
  while (true) {
    try {
      await a.info();
      await delay(20);
    } catch (err) {
      if (err instanceof ConsumerNotFoundError && expected === "consumer") {
        await delay(1000);
        break;
      }
      if (err instanceof StreamNotFoundError && expected === "stream") {
        await delay(1000);
        break;
      }
      fail((err as Error).message);
    }
  }
}
