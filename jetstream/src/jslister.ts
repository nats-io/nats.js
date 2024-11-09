/*
 * Copyright 2021-2024 The NATS Authors
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
import { errors } from "@nats-io/nats-core/internal";
import type { BaseApiClientImpl } from "./jsbaseclient_api.ts";
import type {
  ApiPaged,
  ApiPagedRequest,
  ApiResponse,
  ConsumerListResponse,
  StreamListResponse,
} from "./jsapi_types.ts";
import type { Lister, ListerFieldFilter } from "./types.ts";

export class ListerImpl<T> implements Lister<T>, AsyncIterable<T> {
  err?: Error;
  offset: number;
  pageInfo: ApiPaged;
  subject: string;
  jsm: BaseApiClientImpl;
  filter: ListerFieldFilter<T>;
  payload: unknown;

  constructor(
    subject: string,
    filter: ListerFieldFilter<T>,
    jsm: BaseApiClientImpl,
    payload?: unknown,
  ) {
    if (!subject) {
      throw errors.InvalidArgumentError.format("subject", "is required");
    }
    this.subject = subject;
    this.jsm = jsm;
    this.offset = 0;
    this.pageInfo = {} as ApiPaged;
    this.filter = filter;
    this.payload = payload || {};
  }

  async next(): Promise<T[]> {
    if (this.err) {
      return [];
    }
    if (this.pageInfo && this.offset >= this.pageInfo.total) {
      return [];
    }

    const offset = { offset: this.offset } as ApiPagedRequest;
    if (this.payload) {
      Object.assign(offset, this.payload);
    }
    try {
      const r = await this.jsm._request(
        this.subject,
        offset,
        { timeout: this.jsm.timeout },
      );
      this.pageInfo = r as ApiPaged;
      // offsets are reported in total, so need to count
      // all the entries returned
      const count = this.countResponse(r as ApiResponse);
      if (count === 0) {
        // we are done if we get a null set of infos
        return [];
      }
      this.offset += count;
      return this.filter(r);
    } catch (err) {
      this.err = err as Error;
      throw err;
    }
  }

  countResponse(r?: ApiResponse): number {
    switch (r?.type) {
      case "io.nats.jetstream.api.v1.stream_names_response":
      case "io.nats.jetstream.api.v1.stream_list_response":
        return (r as StreamListResponse).streams?.length || 0;
      case "io.nats.jetstream.api.v1.consumer_list_response":
        return (r as ConsumerListResponse).consumers?.length || 0;
      default:
        console.error(
          `jslister.ts: unknown API response for paged output: ${r?.type}`,
        );
        // has to be a stream...
        return (r as StreamListResponse).streams?.length || 0;
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page = await this.next();
    while (page.length > 0) {
      for (const item of page) {
        yield item;
      }
      page = await this.next();
    }
  }
}
