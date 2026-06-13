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

import type { ConnectionOptions, NatsConnection } from "@nats-io/nats-core";
import type { ConnZ, JSZ, PortInfo, VarZ } from "./launcher.ts";

export interface ManagedServer extends PortInfo {
  certsDir?: string;

  connect(opts?: ConnectionOptions): Promise<NatsConnection>;
  stop(cleanup?: boolean): Promise<void>;
  restart(): Promise<ManagedServer>;

  varz(): Promise<VarZ>;
  jsz(): Promise<JSZ>;
  connz(cid?: number, subs?: boolean | "detail"): Promise<ConnZ>;
  leafz(): Promise<{ leafs: unknown[]; leafnodes: number }>;

  signal(sig: string): Promise<void>;
  reload(conf: unknown): Promise<void>;
  getLog(): string;
  pid(): number;

  [Symbol.asyncDispose](): Promise<void>;
}

export interface ServerFactory {
  start(conf?: unknown, debug?: boolean): Promise<ManagedServer>;
  cluster(
    count: number,
    conf?: unknown,
    debug?: boolean,
  ): Promise<ManagedServer[]>;
  jetstreamCluster(
    count: number,
    conf?: unknown,
    debug?: boolean,
  ): Promise<ManagedServer[]>;
  stopAll(cluster: ManagedServer[], cleanup?: boolean): Promise<void[]>;
}
