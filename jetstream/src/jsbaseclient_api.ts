/*
 * Copyright 2021-2023 The NATS Authors
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

import {
  backoff,
  delay,
  Empty,
  errors,
  extend,
  headers,
  RequestError,
} from "@nats-io/nats-core/internal";
import type {
  Msg,
  NatsConnection,
  NatsConnectionImpl,
  RequestOptions,
} from "@nats-io/nats-core/internal";
import type { ApiResponse, ConsumerApiOptions } from "./jsapi_types.ts";
import type { JetStreamOptions } from "./types.ts";
import {
  ConsumerNotFoundError,
  JetStreamApiCodes,
  JetStreamApiError,
  JetStreamNotEnabled,
  StreamNotFoundError,
} from "./jserrors.ts";

const defaultPrefix = "$JS.API";
const defaultTimeout = 5000;

export function defaultJsOptions(opts?: JetStreamOptions): JetStreamOptions {
  opts = opts || {} as JetStreamOptions;
  if (opts.domain) {
    opts.apiPrefix = `$JS.${opts.domain}.API`;
    delete opts.domain;
  }
  return extend({ apiPrefix: defaultPrefix, timeout: defaultTimeout }, opts);
}

export type StreamNames = {
  streams: string[];
};

export type StreamNameBySubject = {
  subject: string;
};

export type JetStreamApiRequestOptions = RequestOptions & ConsumerApiOptions & {
  retries?: number;
  minApiVersion?: number;
};

export class BaseApiClientImpl {
  nc: NatsConnectionImpl;
  opts: JetStreamOptions;
  prefix: string;
  timeout: number;

  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    this.nc = nc as NatsConnectionImpl;
    this.opts = defaultJsOptions(opts);
    this._parseOpts();
    this.prefix = this.opts.apiPrefix!;
    this.timeout = this.opts.timeout!;
  }

  getOptions(): JetStreamOptions {
    return Object.assign({}, this.opts);
  }

  _parseOpts() {
    let prefix = this.opts.apiPrefix;
    if (!prefix || prefix.length === 0) {
      throw errors.InvalidArgumentError.format("prefix", "cannot be empty");
    }
    const c = prefix[prefix.length - 1];
    if (c === ".") {
      prefix = prefix.substr(0, prefix.length - 1);
    }
    this.opts.apiPrefix = prefix;
  }

  async _request(
    subj: string,
    data: unknown = null,
    opts?: Partial<JetStreamApiRequestOptions>,
  ): Promise<unknown> {
    opts = opts || {} as RequestOptions;
    opts.timeout = this.timeout;

    let a: Uint8Array = Empty;
    if (data) {
      a = new TextEncoder().encode(JSON.stringify(data));
    }

    let { retries, minApiVersion } = opts;

    delete opts.minApiVersion;
    delete opts.retries;

    if (typeof minApiVersion === "number") {
      const h = opts.headers ? opts.headers : headers();
      h.set("Nats-Required-Api-Level", minApiVersion + "");
      opts.headers = h;
    }

    retries = retries || 1;
    retries = retries === -1 ? Number.MAX_SAFE_INTEGER : retries;
    const bo = backoff();

    for (let i = 0; i < retries; i++) {
      try {
        const m = await this.nc.request(
          subj,
          a,
          opts as RequestOptions,
        );
        return this.parseJsResponse(m);
      } catch (err) {
        const re = err instanceof RequestError ? err as RequestError : null;
        if (
          (err instanceof errors.TimeoutError || re?.isNoResponders()) &&
          i + 1 < retries
        ) {
          await delay(bo.backoff(i));
        } else {
          throw re?.isNoResponders()
            ? new JetStreamNotEnabled("jetstream is not enabled", {
              cause: err,
            })
            : err;
        }
      }
    }
  }

  async findStream(subject: string): Promise<string> {
    const q = { subject } as StreamNameBySubject;
    const r = await this._request(`${this.prefix}.STREAM.NAMES`, q);
    const names = r as StreamNames;
    if (!names.streams || names.streams.length !== 1) {
      throw StreamNotFoundError.fromMessage("no stream matches subject");
    }
    return names.streams[0];
  }

  getConnection(): NatsConnection {
    return this.nc;
  }

  parseJsResponse(m: Msg): unknown {
    const v = JSON.parse(new TextDecoder().decode(m.data));
    const r = v as ApiResponse;
    if (r.error) {
      switch (r.error.err_code) {
        case JetStreamApiCodes.ConsumerNotFound:
          throw new ConsumerNotFoundError(r.error);
        case JetStreamApiCodes.StreamNotFound:
          throw new StreamNotFoundError(r.error);
        case JetStreamApiCodes.JetStreamNotEnabledForAccount: {
          const jserr = new JetStreamApiError(r.error);
          throw new JetStreamNotEnabled(jserr.message, { cause: jserr });
        }
        default:
          throw new JetStreamApiError(r.error);
      }
    }
    return v;
  }
}
