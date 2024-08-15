/*
 * Copyright 2023-2024 The NATS Authors
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

import type {
  Codec,
  Msg,
  MsgHdrs,
  Nanos,
  NatsConnectionImpl,
  NatsError,
  Payload,
  QueuedIterator,
  RequestOptions,
  ReviverFn,
  Sub,
  TypedSubscriptionOptions,
} from "@nats-io/nats-core/internal";
import { nanos } from "@nats-io/nats-core/internal";

import {
  AckPolicy,
  defaultConsumer,
  DeliverPolicy,
  ReplayPolicy,
} from "./jsapi_types.ts";

import type {
  ConsumerConfig,
  ConsumerInfo,
  ConsumerUpdateConfig,
  DirectBatchOptions,
  DirectMsgRequest,
  JetStreamAccountStats,
  MsgRequest,
  PullOptions,
  PurgeOpts,
  PurgeResponse,
  StreamAlternate,
  StreamConfig,
  StreamInfo,
  StreamInfoRequestOptions,
  StreamUpdateConfig,
} from "./jsapi_types.ts";
import type { JsMsg } from "./jsmsg.ts";
import { validateDurableName } from "./jsutil.ts";

export interface BaseClient {
  nc: NatsConnectionImpl;
  opts: JetStreamOptions;
  prefix: string;
  timeout: number;
  jc: Codec<unknown>;

  getOptions(): JetStreamOptions;
  findStream(subject: string): Promise<string>;
  parseJsResponse(m: Msg): unknown;
  _request(
    subj: string,
    data?: unknown,
    opts?: RequestOptions,
  ): Promise<unknown>;
}

export interface JetStreamOptions {
  /**
   * Prefix required to interact with JetStream. Must match
   * server configuration.
   */
  apiPrefix?: string;
  /**
   * Number of milliseconds to wait for a JetStream API request.
   * @default ConnectionOptions.timeout
   * @see ConnectionOptions.timeout
   */
  timeout?: number;
  /**
   * Name of the JetStream domain. This value automatically modifies
   * the default JetStream apiPrefix.
   */
  domain?: string;
}

export interface JetStreamManagerOptions extends JetStreamOptions {
  /**
   * Allows disabling a check on the account for JetStream enablement see
   * {@link JetStreamManager.getAccountInfo()}.
   */
  checkAPI?: boolean;
}

/**
 * The response returned by the JetStream server when a message is added to a stream.
 */
export interface PubAck {
  /**
   * The name of the stream
   */
  stream: string;
  /**
   * The domain of the JetStream
   */
  domain?: string;
  /**
   * The sequence number of the message as stored in JetStream
   */
  seq: number;
  /**
   * True if the message is a duplicate
   */
  duplicate: boolean;
}

/**
 * Options for messages published to JetStream
 */
export interface JetStreamPublishOptions {
  /**
   * A string identifier used to detect duplicate published messages.
   * If the msgID is reused within the stream's `duplicate_window`,
   * the message will be rejected by the stream, and the {@link PubAck} will
   * mark it as a `duplicate`.
   */
  msgID: string;
  /**
   * The number of milliseconds to wait for the PubAck
   */
  timeout: number;
  /**
   * Headers associated with the message. You can create an instance of
   * MsgHdrs with the headers() function.
   */
  headers: MsgHdrs;
  /**
   * Set of constraints that when specified are verified by the server.
   * If the constraint(s) doesn't match, the server will reject the message.
   * These settings allow you to implement deduplication and consistency
   * strategies.
   */
  expect: Partial<{
    /**
     * The expected last msgID of the last message received by the stream.
     */
    lastMsgID: string;
    /**
     * The expected stream capturing the message
     */
    streamName: string;
    /**
     * The expected last sequence on the stream.
     */
    lastSequence: number;
    /**
     * The expected last sequence on the stream for a message with this subject
     */
    lastSubjectSequence: number;
  }>;
}

/**
 * A JetStream interface that allows you to request the ConsumerInfo on the backing object.
 */
export interface ConsumerInfoable {
  /** The consumer info for the consumer */
  consumerInfo(): Promise<ConsumerInfo>;
}

/**
 * An interface that reports via a promise when an object such as a connection
 * or subscription closes.
 */
export interface Closed {
  /**
   * A promise that when resolves, indicates that the object is closed.
   */
  closed: Promise<void>;
}

/**
 * The JetStream Subscription object
 */
export type JetStreamSubscription =
  & Sub<JsMsg>
  & Destroyable
  & Closed
  & ConsumerInfoable;
export type JetStreamSubscriptionOptions = TypedSubscriptionOptions<JsMsg>;

export interface Pullable {
  /**
   * Sends a request from the client requesting the server for more messages.
   * @param opts
   */
  pull(opts?: Partial<PullOptions>): void;
}

export interface Destroyable {
  /**
   * Destroys a resource on the server. Returns a promise that resolves to true
   * whene the operation has been completed
   */
  destroy(): Promise<void>;
}

/**
 * The JetStream pull subscription object.
 */
export type JetStreamPullSubscription = JetStreamSubscription & Pullable;
/**
 * The signature a message handler for a JetStream subscription.
 */
export type JsMsgCallback = (err: NatsError | null, msg: JsMsg | null) => void;

/**
 * An interface for listing. Returns a promise with typed list.
 */
export interface Lister<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;

  next(): Promise<T[]>;
}

export type ListerFieldFilter<T> = (v: unknown) => T[];

export interface StreamAPI {
  /**
   * Returns the information about the specified stream
   * @param stream
   * @param opts
   */
  info(
    stream: string,
    opts?: Partial<StreamInfoRequestOptions>,
  ): Promise<StreamInfo>;

  /**
   * Adds a new stream with the specified stream configuration.
   * @param cfg
   */
  add(cfg: Partial<StreamConfig>): Promise<StreamInfo>;

  /**
   * Updates the stream configuration for the specified stream.
   * @param name
   * @param cfg
   */
  update(name: string, cfg: Partial<StreamUpdateConfig>): Promise<StreamInfo>;

  /**
   * Purges messages from a stream that match the specified purge options.
   * @param stream
   * @param opts
   */
  purge(stream: string, opts?: PurgeOpts): Promise<PurgeResponse>;

  /**
   * Deletes the specified stream
   * @param stream
   */
  delete(stream: string): Promise<boolean>;

  /**
   * Lists all streams stored by JetStream
   * @param subject - only return streams that include the specified subject
   */
  list(subject?: string): Lister<StreamInfo>;

  /**
   * Deletes the specified message sequence from the stream
   * @param stream
   * @param seq
   * @param erase - erase the message - by default true
   */
  deleteMessage(stream: string, seq: number, erase?: boolean): Promise<boolean>;

  /**
   * Retrieves the message matching the specified query. Messages can be
   * retrieved by sequence number or by last sequence matching a subject.
   * @param stream
   * @param query
   */
  getMessage(stream: string, query: MsgRequest): Promise<StoredMsg>;

  /**
   * Find the stream that stores the specified subject.
   * @param subject
   */
  find(subject: string): Promise<string>;

  /**
   * Return a Lister of stream names
   * @param subject - if specified, the results are filtered to streams that contain the
   *  subject (can be wildcarded)
   */
  names(subject?: string): Lister<string>;

  /**
   * Returns a Stream object
   * @param name
   */
  get(name: string): Promise<Stream>;
}

export interface ConsumerAPI {
  /**
   * Returns the ConsumerInfo for the specified consumer in the specified stream.
   * @param stream
   * @param consumer
   */
  info(stream: string, consumer: string): Promise<ConsumerInfo>;

  /**
   * Adds a new consumer to the specified stream with the specified consumer options.
   * @param stream
   * @param cfg
   */
  add(stream: string, cfg: Partial<ConsumerConfig>): Promise<ConsumerInfo>;

  /**
   * Updates the consumer configuration for the specified consumer on the specified
   * stream that has the specified durable name.
   * @param stream
   * @param durable
   * @param cfg
   */
  update(
    stream: string,
    durable: string,
    cfg: Partial<ConsumerUpdateConfig>,
  ): Promise<ConsumerInfo>;

  /**
   * Deletes the specified consumer name/durable from the specified stream.
   * @param stream
   * @param consumer
   */
  delete(stream: string, consumer: string): Promise<boolean>;

  /**
   * Lists all the consumers on the specfied streams
   * @param stream
   */
  list(stream: string): Lister<ConsumerInfo>;

  pause(
    stream: string,
    name: string,
    until?: Date,
  ): Promise<{ paused: boolean; pause_until?: string }>;

  resume(
    stream: string,
    name: string,
  ): Promise<{ paused: boolean; pause_until?: string }>;
}

/**
 * The API for interacting with JetStream resources
 */
export interface JetStreamManager {
  /**
   * JetStream API to interact with Consumers
   */
  consumers: ConsumerAPI;
  /**
   * JetStream API to interact with Streams
   */
  streams: StreamAPI;

  /**
   * Returns JetStreamAccountStats for the current client account.
   */
  getAccountInfo(): Promise<JetStreamAccountStats>;

  /**
   * Returns an async iteartor
   */
  advisories(): AsyncIterable<Advisory>;

  /**
   * Returns the {@link JetStreamOptions} used to create this
   * JetStreamManager
   */
  getOptions(): JetStreamOptions;

  /**
   * Returns a {@link JetStreamClient} created using the same
   * options as this JetStreamManager
   */
  jetstream(): JetStreamClient;
}

export type Ordered = {
  ordered: true;
};
export type PushConsumerOptions =
  & ConsumeCallback
  & AbortOnMissingResource;

export type NextOptions = Expires & Bind;
export type ConsumeBytes =
  & MaxBytes
  & Partial<MaxMessages>
  & Partial<ThresholdBytes>
  & Expires
  & IdleHeartbeat
  & ConsumeCallback
  & AbortOnMissingResource
  & Bind;
export type ConsumeMessages =
  & Partial<MaxMessages>
  & Partial<ThresholdMessages>
  & Expires
  & IdleHeartbeat
  & ConsumeCallback
  & AbortOnMissingResource
  & Bind;
export type ConsumeOptions =
  | ConsumeBytes
  | ConsumeMessages;
/**
 * Options for fetching bytes
 */
export type FetchBytes =
  & MaxBytes
  & Partial<MaxMessages>
  & Expires
  & IdleHeartbeat
  & Bind;
/**
 * Options for fetching messages
 */
export type FetchMessages =
  & Partial<MaxMessages>
  & Expires
  & IdleHeartbeat
  & Bind;
export type FetchOptions = FetchBytes | FetchMessages;
export type PullConsumerOptions = FetchOptions | ConsumeOptions;
export type MaxMessages = {
  /**
   * Maximum number of messages to retrieve.
   * @default 100 messages
   */
  max_messages: number;
};
export type MaxBytes = {
  /**
   * Maximum number of bytes to retrieve - note request must fit the entire message
   * to be honored (this includes, subject, headers, etc). Partial messages are not
   * supported.
   */
  max_bytes: number;
};
export type ThresholdMessages = {
  /**
   * Threshold message count on which the client will auto-trigger additional requests
   * from the server. This is only applicable to `consume`.
   * @default  75% of {@link MaxMessages}.
   */
  threshold_messages: number;
};
export type ThresholdBytes = {
  /**
   * Threshold bytes on which the client wil auto-trigger additional message requests
   * from the server. This is only applicable to `consume`.
   * @default 75% of {@link MaxBytes}.
   */
  threshold_bytes: number;
};
export type Expires = {
  /**
   * Amount of milliseconds to wait for messages before issuing another request.
   * Note this value shouldn't be set by the user, as the default provides proper behavior.
   * A low value will stress the server.
   *
   * Minimum value is 1000 (1s).
   * @default 30_000 (30s)
   */
  expires?: number;
};

export type Bind = {
  /**
   * If set to true the client will not try to check on its consumer by issuing consumer info
   * requests. This means that the client may not report consumer not found, etc., and will simply
   * fail request for messages due to missed heartbeats. This option is exclusive of abort_on_missing_resource.
   *
   * This option is not valid on ordered consumers.
   */
  bind?: boolean;
};
export type AbortOnMissingResource = {
  /**
   * If true, consume will abort if the stream or consumer is not found. Default is to recover
   * once the stream/consumer is restored. This option is exclusive of bind.
   */
  abort_on_missing_resource?: boolean;
};
export type IdleHeartbeat = {
  /**
   * Number of milliseconds to wait for a server heartbeat when not actively receiving
   * messages. When two or more heartbeats are missed in a row, the consumer will emit
   * a notification. Note this value shouldn't be set by the user, as the default provides
   * the proper behavior. A low value will stress the server.
   */
  idle_heartbeat?: number;
};
export type ConsumerCallbackFn = (r: JsMsg) => void;
export type ConsumeCallback = {
  /**
   * Process messages using a callback instead of an iterator. Note that when using callbacks,
   * the callback cannot be async. If you must use async functionality, process messages
   * using an iterator.
   */
  callback?: ConsumerCallbackFn;
};

/**
 * ConsumerEvents are informational notifications emitted by ConsumerMessages
 * that may be of interest to a client.
 */
export enum ConsumerEvents {
  /**
   * Notification that heartbeats were missed. This notification is informational.
   * The `data` portion of the status, is a number indicating the number of missed heartbeats.
   * Note that when a client disconnects, heartbeat tracking is paused while
   * the client is disconnected.
   */
  HeartbeatsMissed = "heartbeats_missed",
  /**
   * Notification that the consumer was not found. Consumers that were accessible at
   * least once, will be retried for more messages regardless of the not being found
   * or timeouts etc. This notification includes a count of consecutive attempts to
   * find the consumer. Note that if you get this notification possibly your code should
   * attempt to recreate the consumer. Note that this notification is only informational
   * for ordered consumers, as the consumer will be created in those cases automatically.
   */
  ConsumerNotFound = "consumer_not_found",

  /**
   * Notification that the stream was not found. Consumers were accessible at least once,
   * will be retried for more messages regardless of the not being found
   * or timeouts etc. This notification includes a count of consecutive attempts to
   * find the consumer. Note that if you get this notification possibly your code should
   * attempt to recreate the consumer. Note that this notification is only informational
   * for ordered consumers, as the consumer will be created in those cases automatically.
   */
  StreamNotFound = "stream_not_found",

  /*
   * Notification that the consumer was deleted. This notification
   * means the consumer will not get messages unless it is recreated. The client
   * will continue to attempt to pull messages. Ordered consumer will recreate it.
   */
  ConsumerDeleted = "consumer_deleted",

  /**
   * This notification is specific of ordered consumers and will be notified whenever
   * the consumer is recreated. The argument is the name of the newly created consumer.
   */
  OrderedConsumerRecreated = "ordered_consumer_recreated",
}

/**
 * These events represent informational notifications emitted by ConsumerMessages
 * that can be safely ignored by clients.
 */
export enum ConsumerDebugEvents {
  /**
   * DebugEvents are effectively statuses returned by the server that were ignored
   * by the client. The `data` portion of the
   * status is just a string indicating the code/message of the status.
   */
  DebugEvent = "debug",
  /**
   * Requests for messages can be terminated by the server, these notifications
   * provide information on the number of messages and/or bytes that couldn't
   * be satisfied by the consumer request. The `data` portion of the status will
   * have the format of `{msgsLeft: number, bytesLeft: number}`.
   */
  Discard = "discard",
  /**
   * Notifies that the current consumer will be reset
   */
  Reset = "reset",
  /**
   * Notifies whenever there's a request for additional messages from the server.
   * This notification telegraphs the request options, which should be treated as
   * read-only. This notification is only useful for debugging. Data is PullOptions.
   */
  Next = "next",

  /**
   * Notifies that the client received a server-side heartbeat. The payload the data
   * portion has the format `{natsLastConsumer: string, natsLastStream: string}`;
   */
  Heartbeat = "heartbeat",

  /**
   * Notifies that the client received a server-side flow control message.
   * The data is null.
   */
  FlowControl = "flow_control",
}

export interface ConsumerStatus {
  type: ConsumerEvents | ConsumerDebugEvents;
  data: unknown;
}

export interface PushConsumer
  extends InfoableConsumer, DeleteableConsumer, ConsumerKind {
  consume(opts?: PushConsumerOptions): Promise<ConsumerMessages>;
}

export interface ConsumerKind {
  isPullConsumer(): boolean;
  isPushConsumer(): boolean;
}

export interface ExportedConsumer extends ConsumerKind {
  next(
    opts?: NextOptions,
  ): Promise<JsMsg | null>;

  fetch(
    opts?: FetchOptions,
  ): Promise<ConsumerMessages>;

  consume(
    opts?: ConsumeOptions,
  ): Promise<ConsumerMessages>;
}

export interface InfoableConsumer {
  info(cached?: boolean): Promise<ConsumerInfo>;
}

export interface DeleteableConsumer {
  delete(): Promise<boolean>;
}

export interface Consumer
  extends ExportedConsumer, InfoableConsumer, DeleteableConsumer {
}

export interface Close {
  close(): Promise<void | Error>;

  closed(): Promise<void | Error>;
}

export interface ConsumerMessages extends QueuedIterator<JsMsg>, Close {
  status(): Promise<AsyncIterable<ConsumerStatus>>;
}

/**
 * These options are a subset of {@link ConsumerConfig} and
 * {@link ConsumerUpdateConfig}
 */
export type OrderedConsumerOptions = {
  name_prefix: string;
  filterSubjects: string[] | string;
  deliver_policy: DeliverPolicy;
  opt_start_seq: number;
  opt_start_time: string;
  replay_policy: ReplayPolicy;
  inactive_threshold: number;
  headers_only: boolean;
};

export type OrderedPushConsumerOptions = OrderedConsumerOptions & {
  deliver_subject: string;
  queue?: string;
};

export function isOrderedConsumerOptions(
  v: OrderedPushConsumerOptions | OrderedConsumerOptions,
): v is OrderedPushConsumerOptions {
  return "deliver_subject" in v;
}

export function isPullConsumer(v: PushConsumer | Consumer): v is Consumer {
  return v.isPullConsumer();
}

export function isPushConsumer(v: PushConsumer | Consumer): v is PushConsumer {
  return v.isPushConsumer();
}

/**
 * Interface for interacting with JetStream data
 */
export interface JetStreamClient {
  /**
   * Publishes a message to a stream. If not stream is configured to store the message, the
   * request will fail with {@link ErrorCode.NoResponders} error.
   *
   * @param subj - the subject for the message
   * @param payload - the message's data
   * @param options - the optional message
   */
  publish(
    subj: string,
    payload?: Payload,
    options?: Partial<JetStreamPublishOptions>,
  ): Promise<PubAck>;

  /**
   * Retrieves a single message from JetStream
   * @param stream - the name of the stream
   * @param consumer - the consumer's durable name (if durable) or name if ephemeral
   * @param expires - the number of milliseconds to wait for a message
   * @deprecated - use {@link Consumer#fetch()}
   */
  pull(stream: string, consumer: string, expires?: number): Promise<JsMsg>;

  /**
   * Similar to pull, but able to configure the number of messages, etc. via PullOptions.
   * @param stream - the name of the stream
   * @param durable - the consumer's durable name (if durable) or name if ephemeral
   * @param opts
   * @deprecated - use {@link Consumer#fetch()}
   */
  fetch(
    stream: string,
    durable: string,
    opts?: Partial<PullOptions>,
  ): QueuedIterator<JsMsg>;

  /**
   * Creates a pull subscription. A pull subscription relies on the client to request more
   * messages from the server. If the consumer doesn't exist, it will be created matching
   * the consumer options provided.
   *
   * It is recommended that a consumer be created first using JetStreamManager APIs and then
   * use the bind option to simply attach to the created consumer.
   *
   * If the filter subject is not specified in the options, the filter will be set to match
   * the specified subject.
   *
   * It is more efficient than {@link fetch} or {@link pull} because
   * a single subscription is used between invocations.
   *
   * @param subject - a subject used to locate the stream
   * @param opts
   * @deprecated - use {@link Consumer#fetch()} or {@link Consumer#consume()}
   */
  pullSubscribe(
    subject: string,
    opts: ConsumerOptsBuilder | Partial<ConsumerOpts>,
  ): Promise<JetStreamPullSubscription>;

  /**
   * Creates a push subscription. The JetStream server feeds messages to this subscription
   * without the client having to request them. The rate at which messages are provided can
   * be tuned by the consumer by specifying {@link ConsumerConfig#rate_limit_bps | ConsumerConfig.rate_limit_bps} and/or
   * {@link ConsumerOpts | maxAckPending}.
   *
   * It is recommended that a consumer be created first using JetStreamManager APIs and then
   * use the bind option to simply attach to the created consumer.
   *
   * If the filter subject is not specified in the options, the filter will be set to match
   * the specified subject.
   *
   * @param subject - a subject used to locate the stream
   * @param opts
   * @deprecated - use {@link Consumer#fetch()} or {@link Consumer#consume()}
   */
  subscribe(
    subject: string,
    opts: ConsumerOptsBuilder | Partial<ConsumerOpts>,
  ): Promise<JetStreamSubscription>;

  /**
   * Returns the JS API prefix as processed from the JetStream Options
   */
  apiPrefix: string;

  /**
   * Returns the interface for accessing {@link Consumers}. Consumers
   * allow you to process messages stored in a stream. To create a
   * consumer use {@link JetStreamManager}.
   */
  consumers: Consumers;

  /**
   * Returns the interface for accessing {@link Streams}.
   */
  streams: Streams;

  /**
   * Returns a JetStreamManager that uses the same {@link JetStreamOptions}
   * as the current JetStream context
   */
  jetstreamManager(checkAPI?: boolean): Promise<JetStreamManager>;

  getOptions(): JetStreamOptions;
}

export interface Streams {
  get(stream: string): Promise<Stream>;
}

export function isBoundPushConsumerOptions(
  v: unknown,
): v is BoundPushConsumerOptions {
  return typeof v === "object" && "deliver_subject" in v!;
}

/**
 * For bound push consumers, the client must provide at least the
 * deliver_subject. Note that these values must match the ConsumerConfig
 * exactly
 */
export type BoundPushConsumerOptions = ConsumeCallback & {
  /**
   * The deliver_subject as specified in the ConsumerConfig
   */
  deliver_subject: string;
  /**
   * The deliver_group as specified in the ConsumerConfig
   */
  deliver_group?: string;
  /**
   * The idle_heartbeat in Nanos as specified in the ConsumerConfig.
   * This value starts a client-side timer to detect missing heartbeats.
   * If not specified or values don't match, there will be a skew and
   * the possibility of false heartbeat missed notifications.
   */
  idle_heartbeat?: Nanos;
};

export interface Consumers {
  /**
   * Returns the Consumer configured for the specified stream having the specified name.
   * Consumers are typically created with {@link JetStreamManager}. If no name is specified,
   * the Consumers API will return an ordered consumer.
   *
   * An ordered consumer expects messages to be delivered in order. If there's
   * any inconsistency, the ordered consumer will recreate the underlying consumer at the
   * correct sequence. Note that ordered consumers don't yield messages that can be acked
   * because the client can simply recreate the consumer.
   *
   * {@link Consumer}.
   * @param stream
   * @param name or OrderedConsumerOptions - if not specified an ordered consumer is created
   *  with the specified options.
   */
  get(
    stream: string,
    name?:
      | string
      | Partial<OrderedConsumerOptions>,
  ): Promise<Consumer>;

  getPushConsumer(
    stream: string,
    name?:
      | string
      | Partial<OrderedPushConsumerOptions>
      | BoundPushConsumerOptions,
  ): Promise<PushConsumer>;

  getBoundPushConsumer(opts: BoundPushConsumerOptions): Promise<PushConsumer>;
}

export interface ConsumerOpts {
  /**
   * The consumer configuration
   */
  config: Partial<ConsumerConfig>;
  /**
   * Enable manual ack. When set to true, the client is responsible to ack messages.
   */
  mack: boolean;
  /**
   * The name of the stream
   */
  stream: string;
  /**
   * An optional callback to process messages - note that iterators are the preferred
   * way of processing messages.
   */
  callbackFn?: JsMsgCallback;
  /**
   * The consumer name
   */
  name?: string;
  /**
   * Only applicable to push consumers. When set to true, the consumer will be an ordered
   * consumer.
   */
  ordered: boolean;
  /**
   * Standard option for all subscriptions. Defines the maximum number of messages dispatched
   * by the server before stopping the subscription. For JetStream this may not be accurate as
   * JetStream can add additional protocol messages that could count towards this limit.
   */
  max?: number;
  /**
   * Only applicable to push consumers, allows the pull subscriber to horizontally load balance.
   */
  queue?: string;
  /**
   * If true, the client will only attempt to bind to the specified consumer name/durable on
   * the specified stream. If the consumer is not found, the subscribe will fail
   */
  isBind?: boolean;
}

/**
 * A builder API that creates a ConsumerOpt
 */
export interface ConsumerOptsBuilder {
  /**
   * User description of this consumer
   */
  description(description: string): ConsumerOptsBuilder;

  /**
   * DeliverTo sets the subject where a push consumer receives messages
   * @param subject
   */
  deliverTo(subject: string): ConsumerOptsBuilder;

  /**
   * Sets the durable name, when not set an ephemeral consumer is created
   * @param name
   */
  durable(name: string): ConsumerOptsBuilder;

  /**
   * The consumer will start at the message with the specified sequence
   * @param seq
   */
  startSequence(seq: number): ConsumerOptsBuilder;

  /**
   * consumer will start with messages received on the specified time/date
   * @param time
   */
  startTime(time: Date): ConsumerOptsBuilder;

  /**
   * Consumer will start at first available message on the stream
   */
  deliverAll(): ConsumerOptsBuilder;

  /**
   * Consumer will deliver all the last per messages per subject
   */
  deliverLastPerSubject(): ConsumerOptsBuilder;

  /**
   * Consumer will start at the last message
   */
  deliverLast(): ConsumerOptsBuilder;

  /**
   * Consumer will start with new messages (not yet in the stream)
   */
  deliverNew(): ConsumerOptsBuilder;

  /**
   * Start delivering at the at a past point in time
   * @param millis
   */
  startAtTimeDelta(millis: number): ConsumerOptsBuilder;

  /**
   * Messages delivered to the consumer will not have a payload. Instead,
   * they will have the header `Nats-Msg-Size` indicating the number of bytes
   * in the message as stored by JetStream.
   */
  headersOnly(): ConsumerOptsBuilder;

  /**
   * Consumer will not track ack for messages
   */
  ackNone(): ConsumerOptsBuilder;

  /**
   * Ack'ing a message implicitly acks all messages with a lower sequence
   */
  ackAll(): ConsumerOptsBuilder;

  /**
   * Consumer will ack all messages - not that unless {@link manualAck} is set
   * the client will auto ack messages after processing via its callback or when
   * the iterator continues processing.
   */
  ackExplicit(): ConsumerOptsBuilder;

  /**
   * Sets the time a delivered message might remain unacknowledged before a redelivery is attempted
   * @param millis
   */
  ackWait(millis: number): ConsumerOptsBuilder;

  /**
   * Max number of re-delivery attempts for a particular message
   * @param max
   */
  maxDeliver(max: number): ConsumerOptsBuilder;

  /**
   * Consumer should filter the messages to those that match the specified filter.
   * This api can be called multiple times.
   * @param s
   */
  filterSubject(s: string): ConsumerOptsBuilder;

  /**
   * Replay messages as fast as possible
   */
  replayInstantly(): ConsumerOptsBuilder;

  /**
   * Replay at the rate received
   */
  replayOriginal(): ConsumerOptsBuilder;

  /**
   * Sample a subset of messages expressed as a percentage(0-100)
   * @param n
   */
  sample(n: number): ConsumerOptsBuilder;

  /**
   * Limit message delivery to the specified rate in bits per second.
   * @param bps
   */
  limit(bps: number): ConsumerOptsBuilder;

  /**
   * Pull subscriber option only. Limits the maximum outstanding messages scheduled
   * via batch pulls as pulls are additive.
   * @param max
   */
  maxWaiting(max: number): ConsumerOptsBuilder;

  /**
   * Max number of outstanding acks before the server stops sending new messages
   * @param max
   */
  maxAckPending(max: number): ConsumerOptsBuilder;

  /**
   * Push consumer only option - Enables idle heartbeats from the server. If the number of
   * specified millis is reached and no messages are available on the server, the server will
   * send a heartbeat (status code 100 message) indicating that the JetStream consumer is alive.
   * @param millis
   */
  idleHeartbeat(millis: number): ConsumerOptsBuilder;

  /**
   * Push consumer flow control - the server sends a status code 100 and uses the delay on the
   * response to throttle inbound messages for a client and prevent slow consumer.
   */
  flowControl(): ConsumerOptsBuilder;

  /**
   * Push consumer only option - Sets the name of the queue group - same as queue
   * @param name
   */
  deliverGroup(name: string): ConsumerOptsBuilder;

  /**
   * Prevents the consumer implementation from auto-acking messages. Message callbacks
   * and iterators must explicitly ack messages.
   */
  manualAck(): ConsumerOptsBuilder;

  /**
   * Standard NATS subscription option which automatically closes the subscription after the specified
   * number of messages (actual stream or flow control) are seen by the client.
   * @param max
   */
  maxMessages(max: number): ConsumerOptsBuilder;

  /**
   * Push consumer only option - Standard NATS queue group option, same as {@link deliverGroup}
   * @param n
   */
  queue(n: string): ConsumerOptsBuilder;

  /**
   * Use a callback to process messages. If not specified, you process messages by iterating
   * on the returned subscription object.
   * @param fn
   */
  callback(fn: JsMsgCallback): ConsumerOptsBuilder;

  /**
   * Push consumer only - creates an ordered consumer - ordered consumers cannot be a pull consumer
   * nor specify durable, deliverTo, specify an ack policy, maxDeliver, or flow control.
   */
  orderedConsumer(): ConsumerOptsBuilder;

  /**
   * Bind to the specified durable (or consumer name if ephemeral) on the specified stream.
   * If the consumer doesn't exist, the subscribe will fail. Bind the recommended way
   * of subscribing to a stream, as it requires the consumer to exist already.
   * @param stream
   * @param durable
   */
  bind(stream: string, durable: string): ConsumerOptsBuilder;

  /**
   * Specify the name of the stream, avoiding a lookup where the stream is located by
   * searching for a subject.
   * @param stream
   */
  bindStream(stream: string): ConsumerOptsBuilder;

  /**
   * Pull consumer only - Sets the max number of messages that can be pulled in a batch
   * that can be requested by a client during a pull.
   * @param n
   */
  maxPullBatch(n: number): ConsumerOptsBuilder;

  /**
   * Pull consumer only - Sets the max amount of time before a pull request expires that
   * may be requested by a client during a pull.
   * @param millis
   */
  maxPullRequestExpires(millis: number): ConsumerOptsBuilder;

  /**
   * Pull consumer only - Sets the max amount of time that an ephemeral consumer will be
   * allowed to live on the server. If the client doesn't perform any requests during the
   * specified interval the server will discard the consumer.
   * @param millis
   */
  inactiveEphemeralThreshold(millis: number): ConsumerOptsBuilder;

  /**
   * Force the consumer state to be kept in memory rather than inherit the setting from
   * the Stream
   */
  memory(): ConsumerOptsBuilder;

  /**
   * When set do not inherit the replica count from the stream but specifically set it to this amount
   */
  numReplicas(n: number): ConsumerOptsBuilder;

  /**
   * The name of the consumer
   * @param n
   */
  consumerName(n: string): ConsumerOptsBuilder;
}

/**
 * The Direct stream API is a bit more performant for retrieving messages,
 * but requires the stream to have enabled direct access.
 * See {@link StreamConfig.allow_direct}.
 */
export interface DirectStreamAPI {
  /**
   * Retrieves the message matching the specified query. Messages can be
   * retrieved by sequence number or by last sequence matching a subject, or
   * by looking for the next message sequence that matches a subject.
   * @param stream
   * @param query
   */
  getMessage(stream: string, query: DirectMsgRequest): Promise<StoredMsg>;

  /**
   * Retrieves all last subject messages for the specified subjects
   * @param stream
   * @param opts
   */
  getBatch(
    stream: string,
    opts: DirectBatchOptions,
  ): Promise<QueuedIterator<StoredMsg>>;
}

/**
 * An interface representing a message that retrieved directly from JetStream.
 */
export interface StoredMsg {
  /**
   * The subject the message was originally received on
   */
  subject: string;
  /**
   * The sequence number of the message in the Stream
   */
  seq: number;
  /**
   * Headers for the message
   */
  header: MsgHdrs;
  /**
   * The payload of the message body
   */
  data: Uint8Array;
  /**
   * The time the message was received
   */
  time: Date;

  /**
   * The raw ISO formatted date returned by the server
   */
  timestamp: string;

  /**
   * Convenience method to parse the message payload as JSON. This method
   * will throw an exception if there's a parsing error;
   * @param reviver
   */
  json<T>(reviver?: ReviverFn): T;

  /**
   * Convenience method to parse the message payload as string. This method
   * may throw an exception if there's a conversion error
   */
  string(): string;
}

export interface DirectMsg extends StoredMsg {
  /**
   * The name of the Stream storing message
   */
  stream: string;
}

/**
 * An advisory is an interesting event in the JetStream server
 */
export interface Advisory {
  /**
   * The type of the advisory
   */
  kind: AdvisoryKind;
  /**
   * Payload associated with the advisory
   */
  data: unknown;
}

/**
 * The different kinds of Advisories
 */
export enum AdvisoryKind {
  API = "api_audit",
  StreamAction = "stream_action",
  ConsumerAction = "consumer_action",
  SnapshotCreate = "snapshot_create",
  SnapshotComplete = "snapshot_complete",
  RestoreCreate = "restore_create",
  RestoreComplete = "restore_complete",
  MaxDeliver = "max_deliver",
  Terminated = "terminated",
  Ack = "consumer_ack",
  StreamLeaderElected = "stream_leader_elected",
  StreamQuorumLost = "stream_quorum_lost",
  ConsumerLeaderElected = "consumer_leader_elected",
  ConsumerQuorumLost = "consumer_quorum_lost",
}

export interface Stream {
  name: string;

  info(
    cached?: boolean,
    opts?: Partial<StreamInfoRequestOptions>,
  ): Promise<StreamInfo>;

  alternates(): Promise<StreamAlternate[]>;

  best(): Promise<Stream>;

  getConsumer(
    name?: string | Partial<OrderedConsumerOptions>,
  ): Promise<Consumer>;

  getPushConsumer(
    name?:
      | string
      | Partial<OrderedPushConsumerOptions>
      | { subject: string },
  ): Promise<PushConsumer>;

  getMessage(query: MsgRequest): Promise<StoredMsg>;

  deleteMessage(seq: number, erase?: boolean): Promise<boolean>;
}

export enum JsHeaders {
  /**
   * Set if message is from a stream source - format is `stream seq`
   */
  StreamSourceHdr = "Nats-Stream-Source",
  /**
   * Set for heartbeat messages
   */
  LastConsumerSeqHdr = "Nats-Last-Consumer",
  /**
   * Set for heartbeat messages
   */
  LastStreamSeqHdr = "Nats-Last-Stream",
  /**
   * Set for heartbeat messages if the consumer is stalled
   */
  ConsumerStalledHdr = "Nats-Consumer-Stalled",
  /**
   * Set for headers_only consumers indicates the number of bytes in the payload
   */
  MessageSizeHdr = "Nats-Msg-Size",
  // rollup header
  RollupHdr = "Nats-Rollup",
  // value for rollup header when rolling up a subject
  RollupValueSubject = "sub",
  // value for rollup header when rolling up all subjects
  RollupValueAll = "all",
  /**
   * Set on protocol messages to indicate pull request message count that
   * was not honored.
   */
  PendingMessagesHdr = "Nats-Pending-Messages",
  /**
   * Set on protocol messages to indicate pull request byte count that
   * was not honored
   */
  PendingBytesHdr = "Nats-Pending-Bytes",
}

export enum DirectMsgHeaders {
  Stream = "Nats-Stream",
  Sequence = "Nats-Sequence",
  TimeStamp = "Nats-Time-Stamp",
  Subject = "Nats-Subject",
}

export enum RepublishHeaders {
  /**
   * The source stream of the message
   */
  Stream = "Nats-Stream",
  /**
   * The original subject of the message
   */
  Subject = "Nats-Subject",
  /**
   * The sequence of the republished message
   */
  Sequence = "Nats-Sequence",
  /**
   * The stream sequence id of the last message ingested to the same original subject (or 0 if none or deleted)
   */
  LastSequence = "Nats-Last-Sequence",
  /**
   * The size in bytes of the message's body - Only if {@link Republish#headers_only} is set.
   */
  Size = "Nats-Msg-Size",
}

export interface JetStreamSubscriptionInfoable {
  info: JetStreamSubscriptionInfo | null;
}

export interface JetStreamSubscriptionInfo extends ConsumerOpts {
  api: BaseClient;
  last: ConsumerInfo;
  attached: boolean;
  deliver: string;
  bind: boolean;
  "ordered_consumer_sequence": { "delivery_seq": number; "stream_seq": number };
  "flow_control": {
    "heartbeat_count": number;
    "fc_count": number;
    "consumer_restarts": number;
  };
}

// FIXME: some items here that may need to be addressed
// 503s?
// maxRetries()
// retryBackoff()
// ackWait(time)
// replayOriginal()
// rateLimit(bytesPerSec)
export class ConsumerOptsBuilderImpl implements ConsumerOptsBuilder {
  config: Partial<ConsumerConfig>;
  ordered: boolean;
  mack: boolean;
  stream: string;
  callbackFn?: JsMsgCallback;
  max?: number;
  qname?: string;
  isBind?: boolean;
  filters?: string[];

  constructor(opts?: Partial<ConsumerConfig>) {
    this.stream = "";
    this.mack = false;
    this.ordered = false;
    this.config = defaultConsumer("", opts || {});
  }

  getOpts(): ConsumerOpts {
    const o = {} as ConsumerOpts;
    o.config = Object.assign({}, this.config);
    if (o.config.filter_subject) {
      this.filterSubject(o.config.filter_subject);
      o.config.filter_subject = undefined;
    }
    if (o.config.filter_subjects) {
      o.config.filter_subjects?.forEach((v) => {
        this.filterSubject(v);
      });
      o.config.filter_subjects = undefined;
    }

    o.mack = this.mack;
    o.stream = this.stream;
    o.callbackFn = this.callbackFn;
    o.max = this.max;
    o.queue = this.qname;
    o.ordered = this.ordered;
    o.config.ack_policy = o.ordered ? AckPolicy.None : o.config.ack_policy;
    o.isBind = o.isBind || false;

    if (this.filters) {
      switch (this.filters.length) {
        case 0:
          break;
        case 1:
          o.config.filter_subject = this.filters[0];
          break;
        default:
          o.config.filter_subjects = this.filters;
      }
    }
    return o;
  }

  description(description: string): ConsumerOptsBuilder {
    this.config.description = description;
    return this;
  }

  deliverTo(subject: string): ConsumerOptsBuilder {
    this.config.deliver_subject = subject;
    return this;
  }

  durable(name: string): ConsumerOptsBuilder {
    validateDurableName(name);
    this.config.durable_name = name;
    return this;
  }

  startSequence(seq: number): ConsumerOptsBuilder {
    if (seq <= 0) {
      throw new Error("sequence must be greater than 0");
    }
    this.config.deliver_policy = DeliverPolicy.StartSequence;
    this.config.opt_start_seq = seq;
    return this;
  }

  startTime(time: Date): ConsumerOptsBuilder {
    this.config.deliver_policy = DeliverPolicy.StartTime;
    this.config.opt_start_time = time.toISOString();
    return this;
  }

  deliverAll(): ConsumerOptsBuilder {
    this.config.deliver_policy = DeliverPolicy.All;
    return this;
  }

  deliverLastPerSubject(): ConsumerOptsBuilder {
    this.config.deliver_policy = DeliverPolicy.LastPerSubject;
    return this;
  }

  deliverLast(): ConsumerOptsBuilder {
    this.config.deliver_policy = DeliverPolicy.Last;
    return this;
  }

  deliverNew(): ConsumerOptsBuilder {
    this.config.deliver_policy = DeliverPolicy.New;
    return this;
  }

  startAtTimeDelta(millis: number): ConsumerOptsBuilder {
    this.startTime(new Date(Date.now() - millis));
    return this;
  }

  headersOnly(): ConsumerOptsBuilder {
    this.config.headers_only = true;
    return this;
  }

  ackNone(): ConsumerOptsBuilder {
    this.config.ack_policy = AckPolicy.None;
    return this;
  }

  ackAll(): ConsumerOptsBuilder {
    this.config.ack_policy = AckPolicy.All;
    return this;
  }

  ackExplicit(): ConsumerOptsBuilder {
    this.config.ack_policy = AckPolicy.Explicit;
    return this;
  }

  ackWait(millis: number): ConsumerOptsBuilder {
    this.config.ack_wait = nanos(millis);
    return this;
  }

  maxDeliver(max: number): ConsumerOptsBuilder {
    this.config.max_deliver = max;
    return this;
  }

  filterSubject(s: string): ConsumerOptsBuilder {
    this.filters = this.filters || [];
    this.filters.push(s);
    return this;
  }

  replayInstantly(): ConsumerOptsBuilder {
    this.config.replay_policy = ReplayPolicy.Instant;
    return this;
  }

  replayOriginal(): ConsumerOptsBuilder {
    this.config.replay_policy = ReplayPolicy.Original;
    return this;
  }

  sample(n: number): ConsumerOptsBuilder {
    n = Math.trunc(n);
    if (n < 0 || n > 100) {
      throw new Error(`value must be between 0-100`);
    }
    this.config.sample_freq = `${n}%`;
    return this;
  }

  limit(n: number): ConsumerOptsBuilder {
    this.config.rate_limit_bps = n;
    return this;
  }

  maxWaiting(max: number): ConsumerOptsBuilder {
    this.config.max_waiting = max;
    return this;
  }

  maxAckPending(max: number): ConsumerOptsBuilder {
    this.config.max_ack_pending = max;
    return this;
  }

  idleHeartbeat(millis: number): ConsumerOptsBuilder {
    this.config.idle_heartbeat = nanos(millis);
    return this;
  }

  flowControl(): ConsumerOptsBuilder {
    this.config.flow_control = true;
    return this;
  }

  deliverGroup(name: string): ConsumerOptsBuilder {
    this.queue(name);
    return this;
  }

  manualAck(): ConsumerOptsBuilder {
    this.mack = true;
    return this;
  }

  maxMessages(max: number): ConsumerOptsBuilder {
    this.max = max;
    return this;
  }

  callback(fn: JsMsgCallback): ConsumerOptsBuilder {
    this.callbackFn = fn;
    return this;
  }

  queue(n: string): ConsumerOptsBuilder {
    this.qname = n;
    this.config.deliver_group = n;
    return this;
  }

  orderedConsumer(): ConsumerOptsBuilder {
    this.ordered = true;
    return this;
  }

  bind(stream: string, durable: string): ConsumerOptsBuilder {
    this.stream = stream;
    this.config.durable_name = durable;
    this.isBind = true;
    return this;
  }

  bindStream(stream: string): ConsumerOptsBuilder {
    this.stream = stream;
    return this;
  }

  inactiveEphemeralThreshold(millis: number): ConsumerOptsBuilder {
    this.config.inactive_threshold = nanos(millis);
    return this;
  }

  maxPullBatch(n: number): ConsumerOptsBuilder {
    this.config.max_batch = n;
    return this;
  }

  maxPullRequestExpires(millis: number): ConsumerOptsBuilder {
    this.config.max_expires = nanos(millis);
    return this;
  }

  memory(): ConsumerOptsBuilder {
    this.config.mem_storage = true;
    return this;
  }

  numReplicas(n: number): ConsumerOptsBuilder {
    this.config.num_replicas = n;
    return this;
  }

  consumerName(n: string): ConsumerOptsBuilder {
    this.config.name = n;
    return this;
  }
}

export function consumerOpts(
  opts?: Partial<ConsumerConfig>,
): ConsumerOptsBuilder {
  return new ConsumerOptsBuilderImpl(opts);
}

export function isConsumerOptsBuilder(
  o: ConsumerOptsBuilder | Partial<ConsumerOpts>,
): o is ConsumerOptsBuilderImpl {
  return typeof (o as ConsumerOptsBuilderImpl).getOpts === "function";
}
