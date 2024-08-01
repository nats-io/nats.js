/*
 * Copyright 2020-2022 The NATS Authors
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

import { TD, TE } from "./encoders.ts";
import { ErrorCode, NatsError } from "./core.ts";

export interface Codec<T> {
  /**
   * Encode T to an Uint8Array suitable for including in a message payload.
   * @param d
   */
  encode(d: T): Uint8Array;

  /**
   * Decode an Uint8Array from a message payload into a T
   * @param a
   */
  decode(a: Uint8Array): T;
}

/**
 * Returns a {@link Codec} for encoding strings to a message payload
 * and decoding message payloads into strings.
 */
export function StringCodec(): Codec<string> {
  return {
    encode(d: string): Uint8Array {
      return TE.encode(d);
    },
    decode(a: Uint8Array): string {
      return TD.decode(a);
    },
  };
}

/**
 * Returns a {@link Codec}  for encoding JavaScript object to JSON and
 * serialize them to an Uint8Array, and conversely, from an
 * Uint8Array to JSON to a JavaScript Object.
 * @param reviver
 */
export function JSONCodec<T = unknown>(
  reviver?: (this: unknown, key: string, value: unknown) => unknown,
): Codec<T> {
  return {
    encode(d: T): Uint8Array {
      try {
        if (d === undefined) {
          // @ts-ignore: json will not handle undefined
          d = null;
        }
        return TE.encode(JSON.stringify(d));
      } catch (err) {
        throw NatsError.errorForCode(ErrorCode.BadJson, err);
      }
    },

    decode(a: Uint8Array): T {
      try {
        return JSON.parse(TD.decode(a), reviver);
      } catch (err) {
        throw NatsError.errorForCode(ErrorCode.BadJson, err);
      }
    },
  };
}
