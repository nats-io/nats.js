/*
 * Copyright 2024 Synadia Communications, Inc
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
  Msg,
  Nanos,
  Payload,
  PublishOptions,
  QueuedIterator,
} from "@nats-io/nats-core";

export interface ServiceMsg extends Msg {
  respondError(
    code: number,
    description: string,
    data?: Payload,
    opts?: PublishOptions,
  ): boolean;
}

export type ServiceHandler = (err: Error | null, msg: ServiceMsg) => void;
/**
 * A service Endpoint
 */
export type Endpoint = {
  /**
   * Subject where the endpoint listens
   */
  subject: string;
  /**
   * An optional handler - if not set the service is an iterator
   * @param err
   * @param msg
   */
  handler?: ServiceHandler;
  /**
   * Optional metadata about the endpoint
   */
  metadata?: Record<string, string>;
  /**
   * Optional queue group to run this particular endpoint in. The service's configuration
   * queue configuration will be used. See {@link ServiceConfig}. Note that if the queue
   * is set to an empty string, it will not be run in a queue.
   */
  queue?: string;
};
export type EndpointOptions = Partial<Endpoint>;
export type EndpointInfo = {
  name: string;
  subject: string;
  metadata?: Record<string, string>;
  queue_group?: string;
};

export interface ServiceGroup {
  /**
   * The name of the endpoint must be a simple subject token with no wildcards
   * @param name
   * @param opts is either a handler or a more complex options which allows a
   *  subject, handler, and/or schema
   */
  addEndpoint(
    name: string,
    opts?: ServiceHandler | EndpointOptions,
  ): QueuedIterator<ServiceMsg>;

  /**
   * A group is a subject prefix from which endpoints can be added.
   * Can be empty to allow for prefixes or tokens that are set at runtime
   * without requiring editing of the service.
   * Note that an optional queue can be specified, all endpoints added to
   * the group, will use the specified queue unless the endpoint overrides it.
   * When not set, it uses the parent group configuration. An empty string
   * means no queue.
   * see {@link EndpointOptions} and {@link ServiceConfig}.
   * @param subject
   * @param queue
   */
  addGroup(subject?: string, queue?: string): ServiceGroup;
}

export type ServiceMetadata = {
  metadata?: Record<string, string>;
};

export enum ServiceResponseType {
  STATS = "io.nats.micro.v1.stats_response",
  INFO = "io.nats.micro.v1.info_response",
  PING = "io.nats.micro.v1.ping_response",
}

export interface ServiceResponse {
  /**
   * Response type schema
   */
  type: ServiceResponseType;
}

export type ServiceIdentity = ServiceResponse & ServiceMetadata & {
  /**
   * The kind of the service reporting the stats
   */
  name: string;
  /**
   * The unique ID of the service reporting the stats
   */
  id: string;
  /**
   * A version for the service
   */
  version: string;
};
export type NamedEndpointStats = {
  /**
   * The name of the endpoint
   */
  name: string;
  /**
   * The subject the endpoint is listening on
   */
  subject: string;
  /**
   * The number of requests received by the endpoint
   */
  num_requests: number;
  /**
   * Number of errors that the endpoint has raised
   */
  num_errors: number;
  /**
   * If set, the last error triggered by the endpoint
   */
  last_error?: string;
  /**
   * A field that can be customized with any data as returned by stats handler see {@link ServiceConfig}
   */
  data?: unknown;
  /**
   * Total processing_time for the service in nanoseconds
   */
  processing_time: Nanos;
  /**
   * Average processing_time is the total processing_time divided by the num_requests in nanoseconds
   */
  average_processing_time: Nanos;
  /**
   * The queue group the endpoint is listening on
   */
  queue_group?: string;
};
/**
 * Statistics for an endpoint
 */
export type EndpointStats = ServiceIdentity & {
  endpoints?: NamedEndpointStats[];
  /**
   * ISO Date string when the service started
   */
  started: string;
};
export type ServiceInfo = ServiceIdentity & {
  /**
   * Description for the service
   */
  description: string;
  /**
   * Service metadata
   */
  metadata?: Record<string, string>;
  /**
   * Information about the Endpoints
   */
  endpoints: EndpointInfo[];
};
export type ServiceConfig = {
  /**
   * A type for a service
   */
  name: string;
  /**
   * A version identifier for the service
   */
  version: string;
  /**
   * Description for the service
   */
  description?: string;
  /**
   * A customized handler for the stats of an endpoint. The
   * data returned by the endpoint will be serialized as is
   * @param endpoint
   */
  statsHandler?: (
    endpoint: Endpoint,
  ) => Promise<unknown | null>;

  /**
   * Optional metadata about the service
   */
  metadata?: Record<string, string>;
  /**
   * Optional queue group to run the service in. If not set, default,
   * is set to "q". Note that this configuration will
   * be the default for all endpoints and groups. If set to an empty
   * string, the service subscription will NOT have queue, and will
   * not be run in a queue.
   */
  queue?: string;
};
/**
 * The stats of a service
 */
export type ServiceStats = ServiceIdentity & EndpointStats;

export interface Service extends ServiceGroup {
  /**
   * A promise that gets resolved to null or Error once the service ends.
   * If an error, then service exited because of an error.
   */
  stopped: Promise<null | Error>;
  /**
   * True if the service is stopped
   */
  // FIXME: this would be better as stop - but the queued iterator may be an issue perhaps call it `isStopped`
  isStopped: boolean;

  /**
   * Returns the stats for the service.
   */
  stats(): Promise<ServiceStats>;

  /**
   * Returns a service info for the service
   */
  info(): ServiceInfo;

  /**
   * Returns the identity used by this service
   */
  ping(): ServiceIdentity;

  /**
   * Resets all the stats
   */
  reset(): void;

  /**
   * Stop the service returning a promise once the service completes.
   * If the service was stopped due to an error, that promise resolves to
   * the specified error
   */
  stop(err?: Error): Promise<null | Error>;
}

export const ServiceErrorHeader = "Nats-Service-Error";
export const ServiceErrorCodeHeader = "Nats-Service-Error-Code";

export class ServiceError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }

  static isServiceError(msg: Msg): boolean {
    return ServiceError.toServiceError(msg) !== null;
  }

  static toServiceError(msg: Msg): ServiceError | null {
    const scode = msg?.headers?.get(ServiceErrorCodeHeader) || "";
    if (scode !== "") {
      const code = parseInt(scode) || 400;
      const description = msg?.headers?.get(ServiceErrorHeader) || "";
      return new ServiceError(code, description.length ? description : scode);
    }
    return null;
  }
}

export enum ServiceVerb {
  PING = "PING",
  STATS = "STATS",
  INFO = "INFO",
}

export interface ServiceClient {
  /**
   * Pings services
   * @param name - optional
   * @param id - optional
   */
  ping(name?: string, id?: string): Promise<QueuedIterator<ServiceIdentity>>;

  /**
   * Requests all the stats from services
   * @param name
   * @param id
   */
  stats(name?: string, id?: string): Promise<QueuedIterator<ServiceStats>>;

  /**
   * Requests info from services
   * @param name
   * @param id
   */
  info(name?: string, id?: string): Promise<QueuedIterator<ServiceInfo>>;
}
