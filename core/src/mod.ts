/*
 * Copyright 2024 The NATS Authors
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

export {
  AuthorizationError,
  backoff,
  Bench,
  buildAuthenticator,
  canonicalMIMEHeaderKey,
  ClosedConnectionError,
  ConnectionError,
  createInbox,
  credsAuthenticator,
  deadline,
  deferred,
  delay,
  DrainingConnectionError,
  Empty,
  errors,
  hasWsProtocol,
  headers,
  InvalidArgumentError,
  InvalidOperationError,
  InvalidSubjectError,
  jwtAuthenticator,
  Match,
  Metric,
  millis,
  nanos,
  nkeyAuthenticator,
  nkeys,
  NoRespondersError,
  Nuid,
  nuid,
  PermissionViolationError,
  ProtocolError,
  RequestError,
  syncIterator,
  TimeoutError,
  tokenAuthenticator,
  UserAuthenticationExpiredError,
  usernamePasswordAuthenticator,
  wsconnect,
} from "./internal_mod.ts";

import { MsgHdrsImpl as _MsgHdrsImpl } from "./internal_mod.ts";

/**
 * @deprecated MsgHdrsImpl was exposed by mistake - the public APIs only use the
 * {@link MsgHdrs} interface. Create headers with {@link headers}. It will be
 * removed from the public API in a future major release.
 */
export const MsgHdrsImpl: typeof _MsgHdrsImpl = _MsgHdrsImpl;
/**
 * @deprecated MsgHdrsImpl was exposed by mistake - use {@link MsgHdrs}.
 */
export type MsgHdrsImpl = _MsgHdrsImpl;

export type {
  Auth,
  Authenticator,
  Backoff,
  BenchOpts,
  ClientPingStatus,
  CloseStatus,
  ClusterUpdateStatus,
  Codec,
  ConnectionOptions,
  Deferred,
  Delay,
  DisconnectStatus,
  FirstConnectFn,
  ForceReconnectStatus,
  JwtAuth,
  LDMStatus,
  Msg,
  MsgCallback,
  MsgHdrs,
  Nanos,
  NatsConnection,
  NKeyAuth,
  NoAuth,
  Payload,
  Perf,
  Publisher,
  PublishOptions,
  QueuedIterator,
  ReconnectingStatus,
  ReconnectStatus,
  ReconnectToServerHandler,
  RequestManyOptions,
  RequestOptions,
  RequestStrategy,
  ReviverFn,
  Server,
  ServerErrorStatus,
  ServerInfo,
  ServersChanged,
  SlowConsumerStatus,
  StaleConnectionStatus,
  Stats,
  Status,
  SubOpts,
  Subscription,
  SubscriptionOptions,
  SyncIterator,
  Timeout,
  TlsOptions,
  TokenAuth,
  UserPass,
  WithRequired,
  WsConnectionOptions,
  WsSocketFactory,
} from "./internal_mod.ts";
