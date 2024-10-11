/*
 * Copyright 2022-2024 The NATS Authors
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
import {
  Empty,
  JSONCodec,
  QueuedIteratorImpl,
  RequestStrategy,
} from "@nats-io/nats-core/internal";

import type {
  NatsConnection,
  QueuedIterator,
  RequestManyOptions,
} from "@nats-io/nats-core/internal";

import { ServiceImpl } from "./service.ts";
import { ServiceVerb } from "./types.ts";

import type {
  ServiceClient,
  ServiceIdentity,
  ServiceInfo,
  ServiceStats,
} from "./types.ts";

export class ServiceClientImpl implements ServiceClient {
  nc: NatsConnection;
  prefix: string | undefined;
  opts: RequestManyOptions;
  constructor(
    nc: NatsConnection,
    opts: RequestManyOptions = {
      strategy: RequestStrategy.JitterTimer,
      maxWait: 2000,
    },
    prefix?: string,
  ) {
    this.nc = nc;
    this.prefix = prefix;
    this.opts = opts;
  }

  ping(
    name = "",
    id = "",
  ): Promise<QueuedIterator<ServiceIdentity>> {
    return this.q<ServiceIdentity>(ServiceVerb.PING, name, id);
  }

  stats(
    name = "",
    id = "",
  ): Promise<QueuedIterator<ServiceStats>> {
    return this.q<ServiceStats>(ServiceVerb.STATS, name, id);
  }

  info(
    name = "",
    id = "",
  ): Promise<QueuedIterator<ServiceInfo>> {
    return this.q<ServiceInfo>(ServiceVerb.INFO, name, id);
  }

  async q<T>(
    v: ServiceVerb,
    name = "",
    id = "",
  ): Promise<QueuedIterator<T>> {
    const iter = new QueuedIteratorImpl<T>();
    const jc = JSONCodec<T>();
    const subj = ServiceImpl.controlSubject(v, name, id, this.prefix);
    const responses = await this.nc.requestMany(subj, Empty, this.opts);
    (async () => {
      for await (const m of responses) {
        try {
          const s = jc.decode(m.data);
          iter.push(s);
        } catch (err) {
          // @ts-ignore: pushing fn
          iter.push(() => {
            iter.stop(err as Error);
          });
        }
      }
      //@ts-ignore: push a fn
      iter.push(() => {
        iter.stop();
      });
    })().catch((err) => {
      iter.stop(err);
    });
    return iter;
  }
}
