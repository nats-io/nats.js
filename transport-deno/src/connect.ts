/*
 * Copyright 2020-2024 The NATS Authors
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
import { denoResolveHost, DenoTransport } from "./deno_transport.ts";
import type {
  ConnectionOptions,
  NatsConnection,
  Transport,
  TransportFactory,
} from "@nats-io/nats-core/internal";

import {
  errors,
  hasWsProtocol,
  NatsConnectionImpl,
  setTransportFactory,
} from "@nats-io/nats-core/internal";

export function connect(opts: ConnectionOptions = {}): Promise<NatsConnection> {
  if (hasWsProtocol(opts)) {
    return Promise.reject(
      errors.InvalidArgumentError.format(
        `servers`,
        `deno client doesn't support websockets, use the 'wsconnect' function instead`,
      ),
    );
  }
  setTransportFactory({
    factory: (): Transport => {
      return new DenoTransport();
    },
    dnsResolveFn: denoResolveHost,
  } as TransportFactory);

  return NatsConnectionImpl.connect(opts);
}
