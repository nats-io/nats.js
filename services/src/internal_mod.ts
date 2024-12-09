import type { NatsConnection, RequestManyOptions } from "@nats-io/nats-core";
import { ServiceImpl } from "./service.ts";
import { ServiceClientImpl } from "./serviceclient.ts";
import type { Service, ServiceClient, ServiceConfig } from "./types.ts";

export type {
  Endpoint,
  EndpointInfo,
  EndpointOptions,
  EndpointStats,
  NamedEndpointStats,
  Service,
  ServiceClient,
  ServiceConfig,
  ServiceGroup,
  ServiceHandler,
  ServiceIdentity,
  ServiceInfo,
  ServiceMetadata,
  ServiceMsg,
  ServiceResponse,
  ServiceStats,
} from "./types.ts";

export {
  ServiceError,
  ServiceErrorCodeHeader,
  ServiceErrorHeader,
  ServiceResponseType,
  ServiceVerb,
} from "./types.ts";

export class Svcm {
  nc: NatsConnection;

  constructor(nc: NatsConnection) {
    this.nc = nc;
  }

  add(config: ServiceConfig): Promise<Service> {
    try {
      const s = new ServiceImpl(this.nc, config);
      return s.start();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  client(opts?: RequestManyOptions, prefix?: string): ServiceClient {
    return new ServiceClientImpl(this.nc, opts, prefix);
  }
}
