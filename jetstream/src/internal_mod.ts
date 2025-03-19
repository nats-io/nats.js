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

export {
  AdvisoryKind,
  DirectMsgHeaders,
  isBoundPushConsumerOptions,
  isOrderedPushConsumerOptions,
  isPullConsumer,
  isPushConsumer,
  JsHeaders,
  RepublishHeaders,
} from "./types.ts";

export {
  jetstream,
  JetStreamClientImpl,
  jetstreamManager,
  toJetStreamClient,
} from "./jsclient.ts";

export type {
  AbortOnMissingResource,
  Advisory,
  Bind,
  BoundPushConsumerOptions,
  Close,
  Closed,
  ConsumeBytes,
  ConsumeCallback,
  ConsumeMessages,
  ConsumeOptions,
  Consumer,
  ConsumerAPI,
  ConsumerCallbackFn,
  ConsumerDeleted,
  ConsumerKind,
  ConsumerMessages,
  ConsumerNotFound,
  ConsumerNotification,
  Consumers,
  Debug,
  DeleteableConsumer,
  Destroyable,
  DirectStreamAPI,
  Discard,
  ExceededLimits,
  Expires,
  ExportedConsumer,
  FetchBytes,
  FetchMessages,
  FetchOptions,
  FlowControl,
  Heartbeat,
  HeartbeatsMissed,
  IdleHeartbeat,
  InfoableConsumer,
  JetStreamClient,
  JetStreamManager,
  JetStreamManagerOptions,
  JetStreamOptions,
  JetStreamPublishOptions,
  Lister,
  ListerFieldFilter,
  MaxBytes,
  MaxMessages,
  Next,
  NextOptions,
  NoResponders,
  OrderedConsumerOptions,
  OrderedConsumerRecreated,
  OrderedPushConsumerOptions,
  PubAck,
  PushConsumer,
  PushConsumerOptions,
  Reset,
  StoredMsg,
  Stream,
  StreamAPI,
  StreamNotFound,
  Streams,
  ThresholdBytes,
  ThresholdMessages,
} from "./types.ts";

export type { StreamNames } from "./jsbaseclient_api.ts";
export type {
  AccountLimits,
  ApiError,
  ApiPaged,
  ApiPagedRequest,
  ClusterInfo,
  ConsumerConfig,
  ConsumerInfo,
  ConsumerUpdateConfig,
  ExternalStream,
  JetStreamAccountStats,
  JetStreamApiStats,
  JetStreamUsage,
  JetStreamUsageAccountLimits,
  LastForMsgRequest,
  LostStreamData,
  MsgDeleteRequest,
  MsgRequest,
  OverflowMinAckPending,
  OverflowMinPending,
  OverflowMinPendingAndMinAck,
  OverflowOptions,
  PeerInfo,
  Placement,
  PriorityGroups,
  PriorityPolicy,
  PullOptions,
  PurgeBySeq,
  PurgeBySubject,
  PurgeOpts,
  PurgeResponse,
  PurgeTrimOpts,
  Republish,
  SeqMsgRequest,
  SequenceInfo,
  StreamAlternate,
  StreamConfig,
  StreamConsumerLimits,
  StreamInfo,
  StreamListResponse,
  StreamSource,
  StreamSourceInfo,
  StreamState,
  StreamUpdateConfig,
  SubjectTransformConfig,
  Success,
} from "./jsapi_types.ts";

export type { JsMsg } from "./jsmsg.ts";

export {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  PubHeaders,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  StoreCompression,
} from "./jsapi_types.ts";

export type { DeliveryInfo, StreamInfoRequestOptions } from "./jsapi_types.ts";

export { ListerImpl } from "./jslister.ts";

export {
  isMessageNotFound,
  JetStreamApiCodes,
  JetStreamApiError,
  JetStreamError,
  jserrors,
} from "./jserrors.ts";
