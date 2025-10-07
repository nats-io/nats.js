/*
 * Copyright 2023 The NATS Authors
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

import { nuid } from "./nuid.ts";
import { InvalidArgumentError } from "./errors.ts";

export type DisconnectStatus = {
  type: "disconnect";
  server: string;
};

export type ReconnectStatus = {
  type: "reconnect";
  server: string;
};

export type ReconnectingStatus = {
  type: "reconnecting";
};

export type ClusterUpdateStatus = {
  type: "update";
  added?: string[];
  deleted?: string[];
};

export type LDMStatus = {
  type: "ldm";
  server: string;
};

export type ServerErrorStatus = {
  type: "error";
  error: Error;
};

export type ClientPingStatus = {
  type: "ping";
  pendingPings: number;
};

export type StaleConnectionStatus = {
  type: "staleConnection";
};

export type ForceReconnectStatus = {
  type: "forceReconnect";
};

export type SlowConsumerStatus = {
  type: "slowConsumer";
  sub: Subscription;
  pending: number;
};

export type CloseStatus = {
  type: "close";
};

export type Status =
  | DisconnectStatus
  | ReconnectStatus
  | ReconnectingStatus
  | ClusterUpdateStatus
  | LDMStatus
  | ServerErrorStatus
  | ClientPingStatus
  | StaleConnectionStatus
  | SlowConsumerStatus
  | ForceReconnectStatus
  | CloseStatus;

export type MsgCallback<T> = (
  err: Error | null,
  msg: T,
) => void | Promise<never>;

/**
 * Subscription Options
 */
export interface SubOpts<T> {
  /**
   * Optional queue name (subscriptions on the same subject that use queues
   * are horizontally load balanced when part of the same queue).
   */
  queue?: string;
  /**
   * Optional maximum number of messages to deliver to the subscription
   * before it is auto-unsubscribed.
   */
  max?: number;
  /**
   * Optional maximum number of milliseconds before a timer raises an error. This
   * useful to monitor a subscription that is expected to yield messages.
   * The timer is cancelled when the first message is received by the subscription.
   */
  timeout?: number;
  /**
   * An optional function that will handle messages. Typically, messages
   * are processed via an async iterator on the subscription. If this
   * option is provided, messages are processed by the specified function.
   * @param err
   * @param msg
   */
  callback?: MsgCallback<T>;

  /**
   * Number of pending messages in a subscription to exceed prior to considering
   * a subscription a Slow Consumer. By default, slow consumer is on a subscription
   * is not accounted for.
   *
   * This is an experimental option.
   */
  slow?: number;
}

export interface DnsResolveFn {
  (h: string): Promise<string[]>;
}

/**
 * Subscription Options
 */
export type SubscriptionOptions = SubOpts<Msg>;

/**
 * ServerInfo represents information from the connected server
 */
export interface ServerInfo {
  /**
   * True if the server requires authentication
   */
  "auth_required"?: boolean;
  /**
   * Server-assigned client_id
   */
  "client_id": number;
  /**
   * The client's IP as seen by the server
   */
  "client_ip"?: string;
  /**
   * The name or ID of the cluster
   */
  cluster?: string;
  /**
   * Other servers available on the connected cluster
   */
  "connect_urls"?: string[];
  /**
   * Git commit information on the built server binary
   */
  "git_commit"?: string;
  /**
   * Version information on the Go stack used to build the server binary
   */
  go: string;
  /**
   * True if the server supports headers
   */
  headers?: boolean;
  /**
   * Hostname of the connected server
   */
  host: string;
  /**
   * True if the server supports JetStream
   */
  jetstream?: boolean;
  /**
   * True if the server is in Lame Duck Mode
   */
  ldm?: boolean;
  /**
   * Max number of bytes in message that can be sent to the server
   */
  "max_payload": number;
  /**
   * If the server required nkey or JWT authentication the nonce used during authentication.
   */
  nonce?: string;
  /**
   * The port where the server is listening
   */
  port: number;
  /**
   * Version number of the NATS protocol
   */
  proto: number;
  /**
   * The ID of the server
   */
  "server_id": string;
  /**
   * The name of the server
   */
  "server_name": string;
  /**
   * True if TLS is available
   */
  "tls_available"?: boolean;
  /**
   * True if TLS connections are required
   */
  "tls_required"?: boolean;
  /**
   * True if TLS client certificate verification is required
   */
  "tls_verify"?: boolean;
  /**
   * The nats-server version
   */
  version: string;
}

export interface Server {
  hostname: string;
  port: number;
  listen: string;
  src: string;
  tlsName: string;

  resolve(
    opts: Partial<
      {
        fn: DnsResolveFn;
        randomize: boolean;
        debug?: boolean;
        resolve?: boolean;
      }
    >,
  ): Promise<Server[]>;
}

/**
 * ServerChanged records servers in the cluster that were added or deleted.
 */
export interface ServersChanged {
  /** list of added servers */
  readonly added: string[];
  /** list of deleted servers */
  readonly deleted: string[];
}

export const Match = {
  // Exact option is case-sensitive
  Exact: "exact",
  // Case-sensitive, but key is transformed to Canonical MIME representation
  CanonicalMIME: "canonical",
  // Case-insensitive matches
  IgnoreCase: "insensitive",
} as const;

export type Match = typeof Match[keyof typeof Match];

export interface MsgHdrs extends Iterable<[string, string[]]> {
  hasError: boolean;
  status: string;
  code: number;
  description: string;

  get(k: string, match?: Match): string;

  set(k: string, v: string, match?: Match): void;

  append(k: string, v: string, match?: Match): void;

  has(k: string, match?: Match): boolean;

  keys(): string[];

  values(k: string, match?: Match): string[];

  delete(k: string, match?: Match): void;

  last(k: string, match?: Match): string;
}

export interface RequestOptions extends TraceOptions {
  /**
   * number of milliseconds before the request will timeout.
   */
  timeout: number;
  /**
   * MsgHdrs to include with the request.
   */
  headers?: MsgHdrs;
  /**
   * If true, the request API will create a regular NATS subscription
   * to process the response. Otherwise a shared muxed subscriptions is
   * used. Requires {@link reply}
   */
  noMux?: boolean;
  /**
   * The subject where the response should be sent to. Requires {@link noMux}
   */
  reply?: string;
}

export type RequestStrategy = "timer" | "count" | "stall" | "sentinel";

export interface RequestManyOptions extends TraceOptions {
  strategy: RequestStrategy;
  maxWait: number;
  headers?: MsgHdrs;
  maxMessages?: number;
  noMux?: boolean;
  stall?: number;
}

export interface Stats {
  /**
   * Number of bytes received by the client.
   */
  inBytes: number;
  /**
   * Number of bytes sent by the client.
   */
  outBytes: number;
  /**
   * Number of messages received by the client.
   */
  inMsgs: number;
  /**
   * Number of messages sent by the client.
   */
  outMsgs: number;
}

export type Payload = Uint8Array | string;

export interface NatsConnection {
  /**
   * ServerInfo to the currently connected server or undefined
   */
  info?: ServerInfo;

  /**
   * Returns a promise that can be used to monitor if the client closes.
   * The promise can resolve an Error if the reason for the close was
   * an error. Note that the promise doesn't reject, but rather resolves
   * to the error if there was one.
   */
  closed(): Promise<void | Error>;

  /**
   * Close will close the connection to the server. This call will terminate
   * all pending requests and subscriptions. The returned promise resolves when
   * the connection closes.
   */
  close(): Promise<void>;

  /**
   * Publishes the specified data to the specified subject.
   * @param subject
   * @param payload
   * @param options
   */
  publish(
    subject: string,
    payload?: Payload,
    options?: PublishOptions,
  ): void;

  /**
   * Publishes using the subject of the specified message, specifying the
   * data, headers and reply found in the message if any.
   * @param msg
   */
  publishMessage(msg: Msg): void;

  /**
   * Replies using the reply subject of the specified message, specifying the
   * data, headers in the message if any.
   * @param msg
   */
  respondMessage(msg: Msg): boolean;

  /**
   * Subscribe expresses interest in the specified subject. The subject may
   * have wildcards. Messages are delivered to the {@link SubOpts#callback |SubscriptionOptions callback}
   * if specified. Otherwise, the subscription is an async iterator for {@link Msg}.
   *
   * @param subject
   * @param opts
   */
  subscribe(subject: string, opts?: SubscriptionOptions): Subscription;

  /**
   * Publishes a request with specified data in the specified subject expecting a
   * response before {@link RequestOptions#timeout} milliseconds. The api returns a
   * Promise that resolves when the first response to the request is received. If
   * there are no responders (a subscription) listening on the request subject,
   * the request will fail as soon as the server processes it.
   *
   * @param subject
   * @param payload
   * @param opts
   */
  request(
    subject: string,
    payload?: Payload,
    opts?: RequestOptions,
  ): Promise<Msg>;

  /**
   * Publishes a request expecting multiple responses back. Several strategies
   * to determine when the request should stop gathering responses.
   * @param subject
   * @param payload
   * @param opts
   */
  requestMany(
    subject: string,
    payload?: Payload,
    opts?: Partial<RequestManyOptions>,
  ): Promise<AsyncIterable<Msg>>;

  /**
   * Returns a Promise that resolves when the client receives a reply from
   * the server. Use of this API is not necessary by clients.
   */
  flush(): Promise<void>;

  /**
   * Initiates a drain on the connection and returns a promise that resolves when the
   * drain completes and the connection closes.
   *
   * Drain is an ordered shutdown of the client. Instead of abruptly closing the client,
   * subscriptions are drained, that is messages not yet processed by a subscription are
   * handled before the subscription is closed. After subscriptions are drained it is not
   * possible to create a new subscription. Then all pending outbound messages are
   * sent to the server. Finally, the connection is closed.
   */
  drain(): Promise<void>;

  /**
   * Returns true if the client is closed.
   */
  isClosed(): boolean;

  /**
   * Returns true if the client is draining.
   */
  isDraining(): boolean;

  /**
   * Returns the hostport of the server the client is connected to.
   */
  getServer(): string;

  /**
   * Returns an async iterator of {@link Status} that may be
   * useful in understanding when the client looses a connection, or
   * reconnects, or receives an update from the cluster among other things.
   *
   * @return an AsyncIterable<Status>
   */
  status(): AsyncIterable<Status>;

  /**
   * Returns some metrics such as the number of messages and bytes
   * sent and recieved by the client.
   */
  stats(): Stats;

  /**
   * @return the number of milliseconds it took for a {@link flush}.
   */
  rtt(): Promise<number>;

  /**
   * Use of this API is experimental, and it is subject to be removed.
   *
   * reconnect() enables a client to force a reconnect. A reconnect will disconnect
   * the client, and possibly initiate a reconnect to the cluster.  Note that all
   * reconnect caveats apply:
   *
   * - If the reconnection policy given to the client doesn't allow reconnects, the
   * connection will close.
   *
   * - Messages that are inbound or outbound could  be lost.
   *
   * - All requests that are in flight will be rejected.
   *
   * Note that the returned promise will reject if the client is already closed, or if
   * it is in the process of draining. If the client is currently disconnected,
   * this API has no effect, as the client is already attempting to reconnect.
   */
  reconnect(): Promise<void>;
}

/**
 * A reviver function
 */
//deno-lint-ignore no-explicit-any
export type ReviverFn = (key: string, value: any) => any;

/**
 * Represents a message delivered by NATS. This interface is used by
 * Subscribers.
 */
export interface Msg {
  /**
   * The subject the message was sent to
   */
  subject: string;
  /**
   * The subscription ID where the message was dispatched.
   */
  sid: number;
  /**
   * A possible subject where the recipient may publish a reply (in the cases
   * where the message represents a request).
   */
  reply?: string;
  /**
   * The message's data (or payload)
   */
  data: Uint8Array;
  /**
   * Possible headers that may have been set by the server or the publisher.
   */
  headers?: MsgHdrs;

  /**
   * Convenience to publish a response to the {@link reply} subject in the
   * message - this is the same as doing `nc.publish(msg.reply, ...)`.
   * @param payload
   * @param opts
   */
  respond(payload?: Payload, opts?: PublishOptions): boolean;

  /**
   * Convenience method to parse the message payload as JSON. This method
   * will throw an exception if there's a parsing error;
   * @param reviver a reviver function
   */
  json<T>(reviver?: ReviverFn): T;

  /**
   * Convenience method to parse the message payload as string. This method
   * may throw an exception if there's a conversion error
   */
  string(): string;
}

export type SyncIterator<T> = {
  next(): Promise<T | null>;
};

/**
 * syncIterator is a utility function that allows an AsyncIterator to be triggered
 * by calling next() - the utility will yield null if the underlying iterator is closed.
 * Note it is possibly an error to call use this function on an AsyncIterable that has
 * already been started (Symbol.asyncIterator() has been called) from a looping construct.
 */
export function syncIterator<T>(src: AsyncIterable<T>): SyncIterator<T> {
  const iter = src[Symbol.asyncIterator]();
  return {
    async next(): Promise<T | null> {
      const m = await iter.next();
      if (m.done) {
        return Promise.resolve(null);
      }
      return Promise.resolve(m.value);
    },
  };
}

/**
 * Basic interface to a Subscription type
 */
export interface Subscription extends AsyncIterable<Msg> {
  /**
   * A promise that resolves when the subscription closes. If the promise
   * resolves to an error, the subscription was closed because of an error
   * typically a permissions error. Note that this promise doesn't reject, but
   * rather resolves to void (no error) or an Error
   */
  closed: Promise<void | Error>;

  /**
   * Stop the subscription from receiving messages. You can optionally
   * specify that the subscription should stop after the specified number
   * of messages have been received. Note this count is since the lifetime
   * of the subscription.
   * @param max
   */
  unsubscribe(max?: number): void;

  /**
   * Drain the subscription, closing it after processing all messages
   * currently in flight for the client. Returns a promise that resolves
   * when the subscription finished draining.
   */
  drain(): Promise<void>;

  /**
   * Returns true if the subscription is draining.
   */
  isDraining(): boolean;

  /**
   * Returns true if the subscription is closed.
   */
  isClosed(): boolean;

  /**
   * @ignore
   */
  callback: MsgCallback<Msg>;

  /**
   * Returns the subject that was used to create the subscription.
   */
  getSubject(): string;

  /**
   * Returns the number of messages received by the subscription.
   */
  getReceived(): number;

  /**
   * Returns the number of messages that have been processed by the subscription.
   */
  getProcessed(): number;

  /**
   * Returns the number of messages that are pending processing. Note that this
   * is method is only valid for iterators.
   */
  getPending(): number;

  /** @ignore */
  getID(): number;

  /**
   * Return the max number of messages before the subscription will unsubscribe.
   */
  getMax(): number | undefined;
}

/**
 * These options enable message tracing through NATS.
 */
export interface TraceOptions {
  /**
   * If set, the server will send events representing the flow of the
   * message as it moves through the system to this subject.
   */
  traceDestination?: string;
  /**
   * If true, the message will NOT be delivered, and instead will just
   * generate trace information. Note that in the context of requests,
   * this means the service will not be triggered so the operation will
   * timeout or return no responses.
   */
  traceOnly?: boolean;
}

export interface PublishOptions extends TraceOptions {
  /**
   * An optional subject where a response should be sent.
   * Note you must have a subscription listening on this subject
   * to receive the response.
   */
  reply?: string;
  /**
   * Optional headers to include with the message.
   */
  headers?: MsgHdrs;
}

// JetStream Server Types
/**
 * Value expressed as Nanoseconds - use the `nanos(millis)` function
 * to convert millis to nanoseconds. Note that in some environments this
 * could overflow.
 */
export type Nanos = number;

export type CallbackFn = () => void;

export interface Dispatcher<T> {
  push(v: T | CallbackFn): void;
}

export interface QueuedIterator<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;

  stop(err?: Error): void;

  getProcessed(): number;

  getPending(): number;

  getReceived(): number;
}

export interface Publisher {
  publish(
    subject: string,
    data: Payload,
    options?: { reply?: string; headers?: MsgHdrs },
  ): void;
}

export function createInbox(prefix = ""): string {
  prefix = prefix || "_INBOX";
  if (typeof prefix !== "string") {
    throw (new TypeError("prefix must be a string"));
  }
  prefix.split(".")
    .forEach((v) => {
      if (v === "*" || v === ">") {
        throw InvalidArgumentError.format(
          "prefix",
          `cannot have wildcards ('${prefix}')`,
        );
      }
    });
  return `${prefix}.${nuid.next()}`;
}

export interface Request {
  token: string;
  requestSubject: string;
  received: number;

  resolver(err: Error | null, msg: Msg): void;

  cancel(err?: Error): void;
}

/**
 * @type {}
 */
export type NoAuth = void;

/**
 * @type {auth_token: string} the user token
 */
export interface TokenAuth {
  "auth_token": string;
}

/**
 * @type {user: string, pass?: string} the username and
 * optional password if the server requires.
 */
export interface UserPass {
  user: string;
  pass?: string;
}

/**
 * @type {nkey: string, sig: string} the public nkey for the user,
 * and a base64 encoded string for the calculated signature of the
 * challenge nonce.
 */
export interface NKeyAuth {
  nkey: string;
  sig: string;
}

/**
 * @type {jwt: string, nkey?: string, sig?: string} the user JWT,
 * and if not a bearer token also the public nkey for the user,
 * and a base64 encoded string for the calculated signature of the
 * challenge nonce.
 */
export interface JwtAuth {
  jwt: string;
  nkey?: string;
  sig?: string;
}

/**
 * @type NoAuth|TokenAuth|UserPass|NKeyAuth|JwtAuth
 */
export type Auth = NoAuth | TokenAuth | UserPass | NKeyAuth | JwtAuth;

/**
 * Authenticator is an interface that returns credentials.
 * @type function(nonce?: string) => Auth
 */
export interface Authenticator {
  (nonce?: string): Auth;
}

export interface ConnectionOptions {
  /**
   * When the server requires authentication, set an {@link Authenticator}.
   * An authenticator is created automatically for username/password and token
   * authentication configurations
   * if {@link user} and {@link pass} or the {@link token} options are set.
   */
  authenticator?: Authenticator | Authenticator[];
  /**
   * When set to `true` the client will print protocol messages that it receives
   * or sends to the server.
   */
  debug?: boolean;
  /**
   * Sets the maximum count of ping commands that can be awaiting a response
   * before raising a stale connection status {@link StaleConnectionStatus }
   * notification {@link NatsConnection#status} and initiating a reconnect.
   *
   * @see pingInterval
   */
  maxPingOut?: number;
  /**
   * Sets the maximum count of per-server reconnect attempts before giving up.
   * Set to `-1` to never give up.
   *
   * @default 10
   */
  maxReconnectAttempts?: number;
  /**
   * Sets the client name. When set, the server monitoring pages will display
   * this name when referring to this client.
   */
  name?: string;
  /**
   * When set to true, messages published by this client will not match
   * this client's subscriptions, so the client is guaranteed to never
   * receive self-published messages on a subject that it is listening on.
   */
  noEcho?: boolean;
  /**
   * If set to true, the client will not randomize its server connection list.
   */
  noRandomize?: boolean;
  /**
   * Sets the password for a client connection. Requires that the {@link user}
   * option be set. See {@link authenticator}.
   */
  pass?: string;
  /**
   * When set to true, the server may perform additional checks on protocol
   * message requests. This option is only useful for NATS client development
   * and shouldn't be used, as it affects server performance.
   */
  pedantic?: boolean;
  /**
   * Sets the number of milliseconds between client initiated ping commands.
   * See {@link maxPingOut}.
   * @default 2 minutes.
   */
  pingInterval?: number;
  /**
   * Sets the port number on the localhost (127.0.0.1) where the nats-server is running.
   * This option is mutually exclusive with {@link servers}.
   */
  port?: number;
  /**
   * When set to true, the server will attempt to reconnect so long as
   * {@link maxReconnectAttempts} doesn't prevent it.
   * @default true
   */
  reconnect?: boolean;
  /**
   * Set a function that dynamically determines the number of milliseconds
   * that the client should wait for the next reconnect attempt.
   */
  reconnectDelayHandler?: () => number;
  /**
   * Set the upper bound for a random delay in milliseconds added to
   * {@link reconnectTimeWait}.
   *
   * @default 100 millis
   */
  reconnectJitter?: number;
  /**
   * Set the upper bound for a random delay in milliseconds added to
   * {@link reconnectTimeWait}. This only affects TLS connections
   *
   * @default 1000 millis
   */
  reconnectJitterTLS?: number;
  /**
   * Set the number of millisecods between reconnect attempts.
   *
   * @default 2000 millis
   */
  reconnectTimeWait?: number;
  /**
   * Set the hostport(s) where the client should attempt to connect.
   * This option is mutually exclusive with {@link port}.
   *
   * @default 127.0.0.1:4222
   */
  servers?: Array<string> | string;
  /**
   * Sets the number of milliseconds the client should wait for a server
   * handshake to be established.
   *
   * @default 20000 millis
   */
  timeout?: number;
  /**
   * When set (can be an empty object), the client requires a secure connection.
   * TlsOptions honored depend on the runtime. Consult the specific NATS javascript
   * client GitHub repo/documentation. When set to null, the client should fail
   * should not connect using TLS. In the case where TLS is available on the server
   * a standard connection will be used. If TLS is required, the connection will fail.
   */
  tls?: TlsOptions | null;
  /**
   * Set to a client authentication token. Note that these tokens are
   * a specific authentication strategy on the nats-server. This option
   * is mutually exclusive of {@link user} and {@link pass}. See {@link authenticator}.
   */
  token?: string;
  /**
   * Sets the username for a client connection. Requires that the {@link pass}
   * option be set. See {@link authenticator}.
   */
  user?: string;
  /**
   * When set to true, the server will send response to all server commands.
   * This option is only useful for NATS client development and shouldn't
   * be used, as it affects server performance.
   */
  verbose?: boolean;
  /**
   * When set to true {@link maxReconnectAttempts} will not trigger until the client
   * has established one connection.
   */
  waitOnFirstConnect?: boolean;
  /**
   * When set to true, cluster information gossiped by the nats-server will
   * not augment the lists of server(s) known by the client.
   */
  ignoreClusterUpdates?: boolean;
  /**
   * A string prefix (must be a valid subject prefix) prepended to inboxes
   * generated by client. This allows a client with limited subject permissions
   * to specify a subject where requests can deliver responses.
   */
  inboxPrefix?: string;

  /**
   * By default, NATS clients will abort reconnect if they fail authentication
   * twice in a row with the same error, regardless of the reconnect policy.
   * This option should be used with care as it will disable this behaviour when true
   */
  ignoreAuthErrorAbort?: boolean;

  /**
   * When true, the client will not augment timeout and other error traces with
   * additional context as to where the operation was started.
   */
  noAsyncTraces?: boolean;

  /**
   * When false, the connect function will not perform any hostname resolution. Note that
   * by default this option will be true if the client supports hostname resolution.
   * Note that on clients that don't supported (mainly the websocket client, setting this
   * option to true, will throw an exception as this option is not available.
   */
  resolve?: boolean;
}

/**
 * TlsOptions that can be specified to a client. Note that
 * the options are typically runtime specific, so some clients won't support
 * them at all. In other cases they will match to the runtime's TLS options.
 *
 * If no options are specified, but the argument for TlsOptions is an object,
 * the client is requesting to only use connections that are secured by TLS.
 */
export interface TlsOptions {
  /**
   * handshakeFirst option requires the server to be configured with `handshakeFirst: true`.
   */
  handshakeFirst?: boolean;
  certFile?: string;
  cert?: string;
  caFile?: string;
  ca?: string;
  keyFile?: string;
  key?: string;
}

export const DEFAULT_PORT = 4222;
export const DEFAULT_HOST = "127.0.0.1";

export type ConnectFn = (opts: ConnectionOptions) => Promise<NatsConnection>;

export interface URLParseFn {
  (u: string, encrypted?: boolean): string;
}

export type Context = {
  server: ContextServer;
  data: ContextUser;
};

export type ContextServer = {
  name: string;
  host: string;
  id: string;
  version: string;
  tags: string[];
  jetstream: boolean;
  flags: number;
  seq: number;
  time: Date;
};

export type ContextUser = {
  user: string;
  account: string;
  permissions?: {
    publish?: ContextPermission;
    subscribe?: ContextPermission;
    responses?: ContextResponsePermission;
  };
};

export type ContextPermission = {
  deny?: string[];
  allow?: string[];
};

export type ContextResponsePermission = {
  max: number;
  ttl: number;
};

export type RequestInfo = {
  acc: string;
  rtt: number;
  start?: Date;
  host?: string;
  id?: string;
  svc?: string;
  user?: string;
  name?: string;
  lang?: string;
  ver?: string;
  server?: string;
  cluster?: string;
  alts?: string[];
  stop?: Date;
  jwt?: string;
  issuer_key?: string;
  name_tag?: string;
  tags?: string[];
  client_type?: string;
  client_id?: string;
  nonce?: string;
};

export type CallbackOptionalErrorFn = (err: Error | void) => void;

export type ConnectionClosedListener = {
  connectionClosedCallback: CallbackOptionalErrorFn;
};
