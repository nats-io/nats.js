import { delay } from "@nats-io/nats-core";
import { fail } from "node:assert";
import type { Consumer, Stream } from "../src/types.ts";
import { StreamImpl } from "../src/jsmstream_api.ts";

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
  const m = `${expected} not found`;
  while (true) {
    try {
      await a.info();
      await delay(20);
    } catch (err) {
      if ((err as Error).message === m) {
        break;
      } else {
        fail((err as Error).message);
      }
    }
  }
}
