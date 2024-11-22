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

import type { Nanos } from "@nats-io/nats-core";
import { nanos } from "@nats-io/nats-core";
import type { StoredMsg } from "./types.ts";

export interface ApiPaged {
  total: number;
  offset: number;
  limit: number;
}

export interface ApiPagedRequest {
  offset: number;
}

export interface ApiResponse {
  type: string;
  error?: ApiError;
}

export interface ApiError {
  /**
   * HTTP like error code in the 300 to 500 range
   */
  code: number;
  /**
   * A human friendly description of the error
   */
  description: string;
  /**
   * The NATS error code unique to each kind of error
   */
  err_code: number;
}

/**
 * An alternate location to read mirrored data
 */
export interface StreamAlternate {
  /**
   * The mirror Stream name
   */
  name: string;
  /**
   * The name of the cluster holding the Stream
   */
  cluster: string;

  /**
   * The domain holding the Stream
   */
  domain: string;
}

/**
 * Stream configuration info
 */
export interface StreamInfo extends ApiPaged {
  /**
   * The active configuration for the Stream
   */
  config: StreamConfig;
  /**
   * The ISO Timestamp when the stream was created
   */
  created: string;
  /**
   * Detail about the current State of the Stream
   */
  state: StreamState;
  /**
   * Cluster information for the stream if applicable
   */
  cluster?: ClusterInfo;
  /**
   * Information about an upstream stream source in a mirror
   */
  mirror?: StreamSourceInfo;
  /**
   * Sources for the Stream if applicable
   */
  sources?: StreamSourceInfo[];
  /**
   * Alternates for a stream if applicable. Alternates are listed
   * in order of TTL. With streams at the start of the Array potentially
   * closer and faster to access.
   */
  alternates?: StreamAlternate[];
  /**
   * The ISO timestamp when the StreamInfo was generated. This field is only available
   * on servers 2.10.x or better
   */
  "ts"?: string;
}

export interface SubjectTransformConfig {
  /**
   * The source pattern
   */
  src?: string;
  /**
   * The destination pattern
   */
  dest: string;
}

/**
 * Sets default consumer limits for inactive_threshold and max_ack_pending
 * to consumers of this stream that don't specify specific values.
 * This functionality requires a server 2.10.x or better.
 */
export interface StreamConsumerLimits {
  /**
   * The default `inactive_threshold` applied to consumers.
   * This value is specified in nanoseconds. Please use the `nanos()`
   * function to convert between millis and nanoseconds. Or `millis()`
   * to convert a nanosecond value to millis.
   */
  "inactive_threshold"?: Nanos;
  /**
   * The default `max_ack_pending` applied to consumers of the stream.
   */
  "max_ack_pending"?: number;
}

export interface StreamConfig extends StreamUpdateConfig {
  /**
   * A unique name for the Stream
   */
  name: string;
  /**
   * How messages are retained in the Stream, once this is exceeded old messages are removed.
   */
  retention: RetentionPolicy;
  /**
   * The storage backend to use for the Stream.
   */
  storage: StorageType;
  /**
   * How many Consumers can be defined for a given Stream. -1 for unlimited.
   */
  "max_consumers": number;
  /**
   * Maintains a 1:1 mirror of another stream with name matching this property.
   * When a mirror is configured subjects and sources must be empty.
   */
  mirror?: StreamSource; // same as a source
  /**
   * Sealed streams do not allow messages to be deleted via limits or API,
   * sealed streams can not be unsealed via configuration update.
   * Can only be set on already created streams via the Update API
   */
  sealed: boolean;

  /**
   * Sets the first sequence number used by the stream. This property can only be
   * specified when creating the stream, and likely is not valid on mirrors etc.,
   * as it may disrupt the synchronization logic.
   */
  "first_seq": number;
}

/**
 * Stream options that can be updated
 */
export interface StreamUpdateConfig {
  /**
   * A list of subjects to consume, supports wildcards. Must be empty when a mirror is configured. May be empty when sources are configured.
   */
  subjects: string[];
  /**
   * A short description of the purpose of this stream
   */
  description?: string;
  /**
   * For wildcard streams ensure that for every unique subject this many messages are kept - a per subject retention limit
   */
  "max_msgs_per_subject": number;
  /**
   * How many messages may be in a Stream, oldest messages will be removed if the Stream exceeds this size. -1 for unlimited.
   */
  "max_msgs": number;
  /**
   * Maximum age of any message in the stream, expressed in nanoseconds. 0 for unlimited.
   */
  "max_age": Nanos;
  /**
   * How big the Stream may be, when the combined stream size exceeds this old messages are removed. -1 for unlimited.
   */
  "max_bytes": number;
  /**
   * The largest message that will be accepted by the Stream. -1 for unlimited.
   */
  "max_msg_size": number;
  /**
   * When a Stream reach its limits either old messages are deleted or new ones are denied
   */
  discard: DiscardPolicy;
  /**
   * Sets the context of the on a per subject basis. Requires {@link DiscardPolicy#New} as the
   * {@link discard} policy.
   */
  discard_new_per_subject: boolean;
  /**
   * Disables acknowledging messages that are received by the Stream.
   */
  "no_ack"?: boolean;
  /**
   * The time window to track duplicate messages for, expressed in nanoseconds. 0 for default
   * Set {@link JetStreamPublishOptions#msgID} to enable duplicate detection.
   */
  "duplicate_window": Nanos;
  /**
   * List of Stream names to replicate into this Stream
   */
  sources?: StreamSource[];
  /**
   * Allows the use of the {@link JsHeaders#RollupHdr} header to replace all contents of a stream,
   * or subject in a stream, with a single new message
   */
  "allow_rollup_hdrs": boolean;
  /**
   * How many replicas to keep for each message. Min 1, Max 5. Default 1.
   */
  "num_replicas": number;
  /**
   * Placement directives to consider when placing replicas of this stream, random placement when unset
   */
  placement?: Placement;
  /**
   * Restricts the ability to delete messages from a stream via the API.
   * Cannot be changed once set to true
   */
  "deny_delete": boolean;
  /**
   * Restricts the ability to purge messages from a stream via the API.
   * Cannot be change once set to true
   */
  "deny_purge": boolean;
  /**
   * Allow higher performance, direct access to get individual messages via the $JS.DS.GET API
   */
  "allow_direct": boolean;
  /**
   * Allow higher performance, direct access to get individual messages via the $JS.DS.GET API
   */
  "mirror_direct": boolean;
  /**
   * Rules for republishing messages from a stream with subject mapping
   * onto new subjects for partitioning and more
   */
  republish?: Republish;
  /**
   * Metadata field to store additional information about the stream. Note that
   * keys starting with `_nats` are reserved. This feature only supported on servers
   * 2.10.x and better.
   */
  metadata?: Record<string, string>;
  /**
   * Apply a subject transform to incoming messages before doing anything else.
   * This feature only supported on 2.10.x and better.
   */
  "subject_transform"?: SubjectTransformConfig;
  /**
   * Sets the compression level of the stream. This feature is only supported in
   * servers 2.10.x and better.
   */
  compression?: StoreCompression;
  /**
   * The consumer limits applied to consumers that don't specify limits
   * for `inactive_threshold` or `max_ack_pending`. Note that these limits
   * become an upper bound for all clients.
   */
  "consumer_limits"?: StreamConsumerLimits;
}

export interface Republish {
  /**
   * The source subject to republish
   */
  src: string;
  /**
   * The destination to publish to
   */
  dest: string;
  /**
   * Only send message headers, no bodies
   */
  "headers_only"?: boolean;
}

export type ExternalStream = {
  /**
   * API prefix for the remote stream - the API prefix should be something like
   * `$JS.domain.API where domain is the JetStream domain on the NATS server configuration.
   */
  api: string;
  /**
   * Deliver prefix for the remote stream
   */
  deliver?: string;
};

export interface StreamSource {
  /**
   * Name of the stream source
   */
  name: string;
  /**
   * An optional start sequence from which to start reading messages
   */
  "opt_start_seq"?: number;
  /**
   * An optional start time Date string
   */
  "opt_start_time"?: string;
  /**
   * An optional filter subject. If the filter matches the message will be
   * on-boarded.
   */
  "filter_subject"?: string;
  /**
   * This value cannot be set if domain is set
   */
  external?: ExternalStream;
  /**
   * This field is a convenience for setting up an ExternalStream.
   * If set, the value here is used to calculate the JetStreamAPI prefix.
   * This field is never serialized to the server. This value cannot be set
   * if external is set.
   */
  domain?: string;
  /**
   * Apply a subject transforms to sourced messages before doing anything else.
   * This feature only supported on 2.10.x and better.
   */
  subject_transforms?: SubjectTransformConfig[];
}

export interface Placement {
  /**
   * The cluster to place the stream on
   */
  cluster: string;
  /**
   * Tags matching server configuration
   */
  tags: string[];
}

export enum RetentionPolicy {
  /**
   * Retain messages until the limits are reached, then trigger the discard policy.
   */
  Limits = "limits",
  /**
   * Retain messages while there is consumer interest on the particular subject.
   */
  Interest = "interest",
  /**
   * Retain messages until acknowledged
   */
  Workqueue = "workqueue",
}

export enum DiscardPolicy {
  /**
   * Discard old messages to make room for the new ones
   */
  Old = "old",
  /**
   * Discard the new messages
   */
  New = "new",
}

export enum StorageType {
  /**
   * Store persistently on files
   */
  File = "file",
  /**
   * Store in server memory - doesn't survive server restarts
   */
  Memory = "memory",
}

export enum DeliverPolicy {
  /**
   * Deliver all messages
   */
  All = "all",
  /**
   * Deliver starting with the last message
   */
  Last = "last",
  /**
   * Deliver starting with new messages
   */
  New = "new",
  /**
   * Deliver starting with the specified sequence
   */
  StartSequence = "by_start_sequence",
  /**
   * Deliver starting with the specified time
   */
  StartTime = "by_start_time",
  /**
   * Deliver starting with the last messages for every subject
   */
  LastPerSubject = "last_per_subject",
}

export enum AckPolicy {
  /**
   * Messages don't need to be Ack'ed.
   */
  None = "none",
  /**
   * Ack, acknowledges all messages with a lower sequence
   */
  All = "all",
  /**
   * All sequences must be explicitly acknowledged
   */
  Explicit = "explicit",
  /**
   * @ignore
   */
  NotSet = "",
}

export enum ReplayPolicy {
  /**
   * Replays messages as fast as possible
   */
  Instant = "instant",
  /**
   * Replays messages following the original delay between messages
   */
  Original = "original",
}

export enum StoreCompression {
  /**
   * No compression
   */
  None = "none",
  /**
   * S2 compression
   */
  S2 = "s2",
}

/**
 * Options for StreamAPI info requests
 */
export type StreamInfoRequestOptions = {
  /**
   * Include info on deleted subjects.
   */
  "deleted_details": boolean;
  /**
   * Only include information matching the specified subject filter
   */
  "subjects_filter": string;
} & ApiPagedRequest;

export type MsgRequest = SeqMsgRequest | LastForMsgRequest;

/**
 * Request the first message matching specified subject found on or after the specified optional sequence.
 */
export type NextMsgRequest = { seq?: number; next_by_subj: string };

/**
 * Retrieves the last message with the given subject
 */
export type LastForMsgRequest = { "last_by_subj": string };

/**
 * Stream sequence number of the message to retrieve
 */
export type SeqMsgRequest = { seq: number };

/**
 * Start time for the message. This is only supported on servers
 * 2.11.0 and better.
 */
export type StartTimeMsgRequest = { start_time: Date | string };

export type DirectMsgRequest =
  | SeqMsgRequest
  | LastForMsgRequest
  | NextMsgRequest
  | StartTimeMsgRequest;

export type Done = { err?: Error };
export type BatchCallback<T> = (done: Done | null, d: T) => void;
export type StartSeq = { seq?: number };
export type StartTime = { start_time?: Date | string };
export type DirectBatchLimits = {
  batch?: number;
  max_bytes?: number;
  callback?: BatchCallback<StoredMsg>;
};
export type DirectBatchStartSeq = StartSeq & DirectBatchLimits;
export type DirectBatchStartTime = StartTime & DirectBatchLimits;
export type DirectBatchOptions = DirectBatchStartSeq | DirectBatchStartTime;

export type DirectLastFor = {
  multi_last: string[];
  up_to_time?: Date | string;
  up_to_seq?: number;
} & DirectBatchLimits;

export interface StreamState {
  /**
   * Number of messages stored in the Stream
   */
  messages: number;
  /**
   * Combined size of all messages in the Stream
   */
  bytes: number;
  /**
   * Sequence number of the first message in the Stream
   */
  "first_seq": number;
  /**
   * The ISO timestamp of the first message in the Stream
   */
  "first_ts": string;
  /**
   * Sequence number of the last message in the Stream
   */
  "last_seq": number;
  /**
   * The ISO timestamp of the last message in the Stream
   */
  "last_ts": string;
  /**
   * The number of deleted messages
   */
  "num_deleted": number;
  /**
   * IDs of messages that were deleted using the Message Delete API or Interest based streams removing messages out of order
   * {@link StreamInfoRequestOptions | deleted_details} is specified on
   * the request.
   */
  deleted: number[];
  /**
   * Messages that were damaged and unrecoverable
   */
  lost: LostStreamData;
  /**
   * Number of Consumers attached to the Stream
   */
  "consumer_count": number;
  /**
   * The number of unique subjects held in the stream
   */
  num_subjects?: number;
  /**
   * Subjects and their message counts when a {@link StreamInfoRequestOptions | subjects_filter} was set
   */
  subjects?: Record<string, number>;
}

/**
 * Records messages that were damaged and unrecoverable
 */
export interface LostStreamData {
  /**
   * The messages that were lost
   */
  msgs: number[] | null;
  /**
   * The number of bytes that were lost
   */
  bytes: number;
}

export interface ClusterInfo {
  /**
   * The cluster name
   */
  name?: string;
  /**
   * The server name of the RAFT leader
   */
  leader?: string;
  /**
   * The members of the RAFT cluster
   */
  replicas?: PeerInfo[];
}

export interface PeerInfo {
  /**
   * The server name of the peer
   */
  name: string;
  /**
   * Indicates if the server is up-to-date and synchronised
   */
  current: boolean;
  /**
   * Indicates the node is considered offline by the group
   */
  offline: boolean;
  /**
   * Nanoseconds since this peer was last seen
   */
  active: Nanos;
  /**
   * How many uncommitted operations this peer is behind the leader
   */
  lag: number;
}

/**
 * Information about an upstream stream source in a mirror
 */
export interface StreamSourceInfo {
  /**
   * The name of the Stream being replicated
   */
  name: string;
  /**
   * How many messages behind the mirror operation is
   */
  lag: number;
  /**
   * When last the mirror had activity, in nanoseconds. Value will be -1 when there has been no activity.
   */
  active: Nanos;
  /**
   * A possible error
   */
  error?: ApiError;
  /**
   * Apply a subject transforms to sourced messages before doing anything else.
   * This feature only supported on 2.10.x and better.
   */
  subject_transforms?: SubjectTransformConfig[];
}

export type PurgeOpts = PurgeBySeq | PurgeTrimOpts | PurgeBySubject;
export type PurgeBySeq = {
  /**
   * Restrict purging to messages that match this subject
   */
  filter?: string;
  /**
   * Purge all messages up to but not including the message with this sequence.
   */
  seq: number;
};
export type PurgeTrimOpts = {
  /**
   * Restrict purging to messages that match this subject
   */
  filter?: string;
  /**
   * Ensures this many messages are present after the purge.
   */
  keep: number;
};
export type PurgeBySubject = {
  /**
   * Restrict purging to messages that match this subject
   */
  filter: string;
};

export interface PurgeResponse extends Success {
  /**
   * Number of messages purged from the Stream
   */
  purged: number;
}

export enum ConsumerApiAction {
  CreateOrUpdate = "",
  Update = "update",
  Create = "create",
}

export interface CreateConsumerRequest {
  "stream_name": string;
  config: Partial<ConsumerConfig>;
  action?: ConsumerApiAction;
}

export interface StreamMsgResponse extends ApiResponse {
  message: {
    subject: string;
    seq: number;
    data: string;
    hdrs: string;
    time: string;
  };
}

export interface SequenceInfo {
  "consumer_seq": number;
  "stream_seq": number;
  "last_active": Nanos;
}

export interface ConsumerInfo {
  /**
   * The stream hosting the consumer
   */
  "stream_name": string;
  /**
   * A unique name for the consumer, either machine generated or the durable name
   */
  name: string;
  /**
   * The ISO timestamp when the Consumer was created
   */
  created: string;
  /**
   * The consumer configuration
   */
  config: ConsumerConfig;
  /**
   * The last message delivered from this Consumer
   */
  delivered: SequenceInfo;
  /**
   * The highest contiguous acknowledged message
   */
  "ack_floor": SequenceInfo;
  /**
   * The number of messages pending acknowledgement
   * but yet to acknowledged by the client.
   */
  "num_ack_pending": number;
  /**
   * The number of redeliveries that have been performed
   */
  "num_redelivered": number;
  /**
   * The number of pull consumers waiting for messages
   */
  "num_waiting": number;
  /**
   * The number of messages left unconsumed in this Consumer
   */
  "num_pending": number;
  /**
   * The cluster where the consumer is defined
   */
  cluster?: ClusterInfo;
  /**
   * Indicates if any client is connected and receiving messages from a push consumer
   */
  "push_bound": boolean;
  /**
   * The ISO timestamp when the ConsumerInfo was generated. This field is only available
   * on servers 2.10.x or better
   */
  "ts"?: string;

  /**
   * Set to true if the consumer is paused.
   * This field is only available on servers 2.11.x or better
   */
  paused?: boolean;

  /**
   * If the consumer was paused with a resume date, this field specifies the amount of time
   * in nanoseconds remaining until the consumer will be automatically resumed. This field
   * is only available on servers 2.11.x or better
   */
  "pause_remaining": Nanos;
}

export interface ConsumerListResponse extends ApiResponse, ApiPaged {
  consumers: ConsumerInfo[];
}

export interface StreamListResponse extends ApiResponse, ApiPaged {
  streams: StreamInfo[];
}

export interface Success {
  /**
   * True if the operation succeeded
   */
  success: boolean;
}

export type SuccessResponse = ApiResponse & Success;

export type MsgDeleteRequest = SeqMsgRequest & {
  /**
   * Default will securely remove a message and rewrite the data with random data,
   * set this to true to only remove the message
   */
  "no_erase"?: boolean;
};

export interface AccountLimits {
  /**
   * The maximum amount of Memory storage Stream Messages may consume
   */
  "max_memory": number;
  /**
   * The maximum amount of File storage Stream Messages may consume
   */
  "max_storage": number;
  /**
   * The maximum number of Streams an account can create
   */
  "max_streams": number;
  /**
   * The maximum number of Consumer an account can create
   */
  "max_consumers": number;
  /**
   * The maximum number of outstanding ACKs any consumer may configure
   */
  "max_ack_pending": number;
  /**
   * The maximum size any single memory stream may be
   */
  "memory_max_stream_bytes": number;
  /**
   * The maximum size any single storage based stream may be
   */
  "storage_max_stream_bytes": number;
  /**
   * Indicates if Streams created in this account requires the max_bytes property set
   */
  "max_bytes_required": number;
}

export interface JetStreamUsage {
  /**
   * Memory Storage being used for Stream Message storage
   */
  memory: number;
  /**
   * File Storage being used for Stream Message storage
   */
  storage: number;
  /**
   * Number of active Streams
   */
  streams: number;
  /**
   * "Number of active Consumers
   */
  consumers: number;
}

export interface JetStreamUsageAccountLimits extends JetStreamUsage {
  limits: AccountLimits;
}

export interface JetStreamAccountStats extends JetStreamUsageAccountLimits {
  api: JetStreamApiStats;
  domain?: string;
  tiers?: {
    R1?: JetStreamUsageAccountLimits;
    R3?: JetStreamUsageAccountLimits;
  };
}

export interface JetStreamApiStats {
  /**
   * Total number of API requests received for this account
   */
  total: number;
  /**
   * "API requests that resulted in an error response"
   */
  errors: number;
}

export interface AccountInfoResponse
  extends ApiResponse, JetStreamAccountStats {}

export type PriorityGroups = {
  priority_groups?: string[];
  priority_policy?: PriorityPolicy;
};

export type ConsumerConfig = ConsumerUpdateConfig & {
  /**
   * The type of acknowledgment required by the Consumer
   */
  "ack_policy": AckPolicy;
  /**
   * Where to start consuming messages on the stream
   */
  "deliver_policy": DeliverPolicy;
  /**
   * Allows push consumers to form a queue group
   */
  "deliver_group"?: string;
  /**
   * A unique name for a durable consumer
   * Set {@link name} - for ephemeral consumers, also set {@link idle_heartbeat}
   */
  "durable_name"?: string;
  /**
   * The consumer name
   */
  name?: string;
  /**
   * For push consumers this will regularly send an empty mess with Status header 100
   * and a reply subject, consumers must reply to these messages to control
   * the rate of message delivery.
   */
  "flow_control"?: boolean;
  /**
   * If the Consumer is idle for more than this many nanoseconds an empty message with
   * Status header 100 will be sent indicating the consumer is still alive
   */
  "idle_heartbeat"?: Nanos;
  /**
   * The sequence from which to start delivery messages.
   * Requires {@link DeliverPolicy#StartSequence}
   */
  "opt_start_seq"?: number;
  /**
   * The date time from which to start delivering messages
   * Requires {@link DeliverPolicy#StartTime}
   */
  "opt_start_time"?: string;
  /**
   * The rate at which messages will be delivered to clients, expressed in bytes per second
   */
  "rate_limit_bps"?: number;
  /**
   * How messages are played back to the Consumer
   */
  "replay_policy": ReplayPolicy;

  /**
   * Creates a consumer that is initially paused, but will resume at the specified Date and time.
   * Specified as an ISO date time string (Date#toISOString()).
   */
  "pause_until"?: string;
};

export type ConsumerUpdateConfig = PriorityGroups & {
  /**
   * A short description of the purpose of this consume
   */
  description?: string;
  /**
   * How long (in nanoseconds) to allow messages to remain un-acknowledged before attempting redelivery
   */
  "ack_wait"?: Nanos;
  /**
   * The number of times a message will be redelivered to consumers if not acknowledged in time
   */
  "max_deliver"?: number;
  /**
   * @ignore
   */
  "sample_freq"?: string;
  /**
   * The maximum number of messages without acknowledgement that can be outstanding,
   * once this limit is reached message delivery will be suspended
   */
  "max_ack_pending"?: number;
  /**
   * The number of pulls that can be outstanding on a pull consumer,
   * pulls received after this is reached are ignored
   */
  "max_waiting"?: number;
  /**
   * Delivers only the headers of messages in the stream and not the bodies. Additionally,
   * adds Nats-Msg-Size {@link JsHeaders#MessageSizeHdr} header to indicate the size of
   * the removed payload
   */
  "headers_only"?: boolean;
  /**
   * The subject where the push consumer should be sent the messages
   */
  "deliver_subject"?: string;
  /**
   * The largest batch property that may be specified when doing a pull on a Pull Consumer
   */
  "max_batch"?: number;
  /**
   * The maximum expires value that may be set when doing a pull on a Pull Consumer expressed in nanoseconds.
   */
  "max_expires"?: Nanos;
  /**
   * Duration that instructs the server to clean up ephemeral consumers that are inactive for the specified
   * time in nanoseconds
   */
  "inactive_threshold"?: Nanos;
  /**
   * List of durations in nanoseconds that represents a retry timescale for
   * the redelivery of messages
   */
  "backoff"?: Nanos[];
  /**
   * The maximum bytes value that maybe set when dong a pull on a Pull Consumer
   */
  "max_bytes"?: number;
  /**
   * When set do not inherit the replica count from the stream but specifically set it to this amount.
   */
  "num_replicas"?: number;
  /**
   * Force the consumer state to be kept in memory rather than inherit the setting from the stream
   */
  "mem_storage"?: boolean;
  /**
   * Deliver only messages that match the subject filter
   * This is exclusive of {@link filter_subjects}
   */
  "filter_subject"?: string;
  /**
   * Deliver only messages that match the specified filters.
   * This is exclusive of {@link filter_subject}.
   */
  "filter_subjects"?: string[];
  /**
   * Metadata field to store additional information about the consumer. Note that
   * keys starting with `_nats` are reserved. This feature only supported on servers
   * 2.10.x and better.
   */
  metadata?: Record<string, string>;
};

export enum PriorityPolicy {
  None = "none",
  Overflow = "overflow",
}

export function defaultConsumer(
  name: string,
  opts: Partial<ConsumerConfig> = {},
): ConsumerConfig {
  return Object.assign({
    name: name,
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(30 * 1000),
    replay_policy: ReplayPolicy.Instant,
  }, opts);
}

export type OverflowMinPending = {
  /**
   * The name of the priority_group
   */
  group: string;
  /**
   * Only deliver messages when num_pending for the consumer is greater than this value
   */
  min_pending: number;
};

export type OverflowMinAckPending = {
  /**
   * The name of the priority_group
   */
  group: string;
  /**
   * Only deliver messages when num_ack_pending for the consumer is greater than this value
   */
  min_ack_pending: number;
};

export type OverflowMinPendingAndMinAck = {
  /**
   * The name of the priority_group
   */
  group: string;
  /**
   * Only deliver messages when num_pending for the consumer is greater than this value
   */
  min_pending: number;
  /**
   * Only deliver messages when num_ack_pending for the consumer is greater than this value
   */
  min_ack_pending: number;
};

export type OverflowOptions =
  | OverflowMinPending
  | OverflowMinAckPending
  | OverflowMinPendingAndMinAck;

/**
 * Options for a JetStream pull subscription which define how long
 * the pull request will remain open and limits the amount of data
 * that the server could return.
 */
export type PullOptions = Partial<OverflowMinPendingAndMinAck> & {
  /**
   * Max number of messages to retrieve in a pull.
   */
  batch: number;
  /**
   * If true, the request for messages will end when received by the server
   */
  "no_wait": boolean;
  /**
   * If set, the number of milliseconds to wait for the number of messages
   * specified in {@link batch}
   */
  expires: number;
  /**
   * If set, the max number of bytes to receive. The server will limit the
   * number of messages in the batch to fit within this setting.
   */
  "max_bytes": number;

  /**
   * Number of nanos between messages for the server to emit an idle_heartbeat
   */
  "idle_heartbeat": number;
};

export interface DeliveryInfo {
  /**
   * JetStream domain of the message if applicable.
   */
  domain: string;
  /**
   * The hash of the sending account if applicable.
   */
  "account_hash"?: string;
  /**
   * The stream where the message came from
   */
  stream: string;
  /**
   * The intended consumer for the message.
   */
  consumer: string;
  /**
   * The number of times the message has been redelivered.
   */
  redeliveryCount: number;
  /**
   * The sequence number of the message in the stream
   */
  streamSequence: number;
  /**
   * The client delivery sequence for the message
   */
  deliverySequence: number;
  /**
   * The timestamp for the message in nanoseconds. Convert with `millis(n)`,
   */
  timestampNanos: number;
  /**
   * The number of pending messages for the consumer at the time the
   * message was delivered.
   */
  pending: number;
  /**
   * True if the message has been redelivered.
   */
  redelivered: boolean;
}

export enum PubHeaders {
  MsgIdHdr = "Nats-Msg-Id",
  ExpectedStreamHdr = "Nats-Expected-Stream",
  ExpectedLastSeqHdr = "Nats-Expected-Last-Sequence",
  ExpectedLastMsgIdHdr = "Nats-Expected-Last-Msg-Id",
  ExpectedLastSubjectSequenceHdr = "Nats-Expected-Last-Subject-Sequence",
}
