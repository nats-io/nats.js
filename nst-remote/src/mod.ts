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

// Public surface — must mirror @nats-io/nst exports for import-map drop-in.

import "./init.ts";

export { closeRemoteContext, NatsServer } from "./server.ts";
export { registerConnect as registerRemoteConnect } from "./client.ts";
export {
  cleanup,
  jetstreamExportServerConf,
  jetstreamServerConf,
  jsopts,
  notCompatible,
  notSupported,
  setup,
  wsopts,
  wsServerConf,
} from "./helpers.ts";
export type { SetupContext } from "./helpers.ts";

// Re-exports from @nats-io/nst — same surface, no remote-specific behavior.
export {
  assertBetween,
  check,
  Connection,
  disabled,
  flakyTest,
  getConnect,
  Lock,
  registerConnect,
  ServerSignals,
  TestServer,
} from "@nats-io/nst";
export type {
  ConnectFn,
  ConnZ,
  JSZ,
  ManagedServer,
  PortInfo,
  Ports,
  ServerFactory,
  VarZ,
} from "@nats-io/nst";
