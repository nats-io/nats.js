/*
 * Copyright 2021-2023 The NATS Authors
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
import { AckPolicy, jetstream, jetstreamManager } from "../src/mod.ts";
import type { PubAck, StreamConfig } from "../src/mod.ts";

import { Empty, nanos, nuid } from "@nats-io/nats-core";

import type { NatsConnection } from "@nats-io/nats-core";

export async function initStream(
  nc: NatsConnection,
  stream: string = nuid.next(),
  opts: Partial<StreamConfig> = {},
): Promise<{ stream: string; subj: string }> {
  const jsm = await jetstreamManager(nc);
  const subj = `${stream}.A`;
  const sc = Object.assign({ name: stream, subjects: [subj] }, opts);
  await jsm.streams.add(sc);
  return { stream, subj };
}

export async function createConsumer(
  nc: NatsConnection,
  stream: string,
): Promise<string> {
  const jsm = await jetstreamManager(nc);
  const ci = await jsm.consumers.add(stream, {
    name: nuid.next(),
    inactive_threshold: nanos(2 * 60 * 1000),
    ack_policy: AckPolicy.Explicit,
  });

  return ci.name;
}

export type FillOptions = {
  randomize: boolean;
  suffixes: string[];
  payload: number;
};

export function fill(
  nc: NatsConnection,
  prefix: string,
  count = 100,
  opts: Partial<FillOptions> = {},
): Promise<PubAck[]> {
  const js = jetstream(nc);

  const options = Object.assign({}, {
    randomize: false,
    suffixes: "abcdefghijklmnopqrstuvwxyz".split(""),
    payload: 0,
  }, opts) as FillOptions;

  function randomSuffix(): string {
    const idx = Math.floor(Math.random() * options.suffixes.length);
    return options.suffixes[idx];
  }

  const payload = options.payload === 0
    ? Empty
    : new Uint8Array(options.payload);

  const a = Array.from({ length: count }, (_, idx) => {
    const subj = opts.randomize
      ? `${prefix}.${randomSuffix()}`
      : `${prefix}.${options.suffixes[idx % options.suffixes.length]}`;
    return js.publish(subj, payload);
  });

  return Promise.all(a);
}
