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

export { NatsConnectionImpl } from "./nats.ts";
export { Nuid, nuid } from "./nuid.ts";

export { MsgImpl } from "./msg.ts";
export { getResolveFn, setTransportFactory } from "./transport.ts";
export type { Transport, TransportFactory } from "./transport.ts";
export { Connect, INFO, ProtocolHandler } from "./protocol.ts";
export type {
  Backoff,
  Deferred,
  Delay,
  ErrorResult,
  Perf,
  Result,
  Timeout,
  ValueResult,
} from "./util.ts";
export {
  backoff,
  collect,
  deadline,
  deferred,
  delay,
  extend,
  millis,
  nanos,
  render,
  SimpleMutex,
  timeout,
} from "./util.ts";
export { canonicalMIMEHeaderKey, headers, MsgHdrsImpl } from "./headers.ts";
export { Heartbeat } from "./heartbeats.ts";
export type { PH } from "./heartbeats.ts";
export { MuxSubscription } from "./muxsubscription.ts";
export { DataBuffer } from "./databuffer.ts";
export {
  buildAuthenticator,
  checkOptions,
  checkUnsupportedOption,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  defaultOptions,
  hasWsProtocol,
  parseOptions,
} from "./options.ts";
export { RequestOne } from "./request.ts";
export {
  credsAuthenticator,
  jwtAuthenticator,
  nkeyAuthenticator,
  tokenAuthenticator,
  usernamePasswordAuthenticator,
} from "./authenticator.ts";
export type { Codec } from "./codec.ts";
export * from "./nkeys.ts";
export { QueuedIteratorImpl } from "./queued_iterator.ts";
export type { MsgArg, ParserEvent } from "./parser.ts";
export { Kind, Parser, State } from "./parser.ts";
export { DenoBuffer, MAX_SIZE, readAll, writeAll } from "./denobuffer.ts";
export { Bench, Metric } from "./bench.ts";
export type { BenchOpts } from "./bench.ts";
export { TD, TE } from "./encoders.ts";
export { ipV4, isIP, parseIP } from "./ipparser.ts";

export type { SemVer } from "./semver.ts";
export { compare, Feature, Features, parseSemVer } from "./semver.ts";
export { Empty } from "./types.ts";
export { extractProtocolMessage, protoLen } from "./transport.ts";

export type {
  Auth,
  Authenticator,
  CallbackFn,
  ClientPingStatus,
  ClusterUpdateStatus,
  ConnectionOptions,
  DisconnectStatus,
  Dispatcher,
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
  Publisher,
  PublishOptions,
  QueuedIterator,
  ReconnectingStatus,
  ReconnectStatus,
  Request,
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
  TlsOptions,
  TokenAuth,
  UserPass,
} from "./core.ts";
export { createInbox, Match, syncIterator } from "./core.ts";
export { SubscriptionImpl, Subscriptions } from "./protocol.ts";

export type {
  IdleHeartbeatFn,
  IdleHeartbeatOptions,
} from "./idleheartbeat_monitor.ts";
export { IdleHeartbeatMonitor } from "./idleheartbeat_monitor.ts";

export { isIPV4OrHostname, Servers } from "./servers.ts";

export { Base64Codec, Base64UrlCodec, Base64UrlPaddedCodec } from "./base64.ts";

export { SHA256 } from "./sha256.ts";

export { wsconnect, wsUrlParseFn } from "./ws_transport.ts";

export {
  AuthorizationError,
  ClosedConnectionError,
  ConnectionError,
  DrainingConnectionError,
  errors,
  InvalidArgumentError,
  InvalidOperationError,
  InvalidSubjectError,
  NoRespondersError,
  PermissionViolationError,
  ProtocolError,
  RequestError,
  TimeoutError,
  UserAuthenticationExpiredError,
} from "./errors.ts";
