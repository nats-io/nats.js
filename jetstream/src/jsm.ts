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

import { BaseApiClientImpl } from "./jsbaseclient_api.ts";
import { DirectMsgHeaders } from "./types.ts";
import type {
  DirectMsg,
  DirectStreamAPI,
  JetStreamOptions,
  StoredMsg,
} from "./types.ts";
import type {
  Codec,
  Msg,
  MsgHdrs,
  NatsConnection,
  QueuedIterator,
  ReviverFn,
} from "@nats-io/nats-core";
import {
  Empty,
  QueuedIteratorImpl,
  RequestStrategy,
  TD,
} from "@nats-io/nats-core/internal";
import type {
  DirectBatchOptions,
  DirectMsgRequest,
  LastForMsgRequest,
} from "./jsapi_types.ts";
import { validateStreamName } from "./jsutil.ts";
import {
  JetStreamApiCodes,
  JetStreamApiError,
  JetStreamStatus,
} from "./jserrors.ts";

export class DirectStreamAPIImpl extends BaseApiClientImpl
  implements DirectStreamAPI {
  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    super(nc, opts);
  }

  async getMessage(
    stream: string,
    query: DirectMsgRequest,
  ): Promise<StoredMsg> {
    validateStreamName(stream);
    // if doing a last_by_subj request, we append the subject
    // this allows last_by_subj to be subject to permissions (KV)
    let qq: DirectMsgRequest | null = query;
    const { last_by_subj } = qq as LastForMsgRequest;
    if (last_by_subj) {
      qq = null;
    }

    const payload = qq ? JSON.stringify(qq) : Empty;
    const pre = this.opts.apiPrefix || "$JS.API";
    const subj = last_by_subj
      ? `${pre}.DIRECT.GET.${stream}.${last_by_subj}`
      : `${pre}.DIRECT.GET.${stream}`;

    const r = await this.nc.request(
      subj,
      payload,
    );

    if (r.headers?.code !== 0) {
      const status = new JetStreamStatus(r);
      if (status.isMessageNotFound()) {
        // this so to simplify things that handle a non-existing messages
        // as null (such as KV).
        return Promise.reject(
          new JetStreamApiError(
            {
              code: status.code,
              err_code: JetStreamApiCodes.NoMessageFound,
              description: status.description,
            },
          ),
        );
      }
      return Promise.reject(status.toError());
    }

    const dm = new DirectMsgImpl(r);
    return Promise.resolve(dm);
  }

  async getBatch(
    stream: string,
    opts: DirectBatchOptions,
  ): Promise<QueuedIterator<StoredMsg>> {
    validateStreamName(stream);
    const pre = this.opts.apiPrefix || "$JS.API";
    const subj = `${pre}.DIRECT.GET.${stream}`;
    if (!Array.isArray(opts.multi_last) || opts.multi_last.length === 0) {
      return Promise.reject("multi_last is required");
    }
    const payload = JSON.stringify(opts, (key, value) => {
      if (key === "up_to_time" && value instanceof Date) {
        return value.toISOString();
      }
      return value;
    });

    const iter = new QueuedIteratorImpl<StoredMsg>();

    const raw = await this.nc.requestMany(
      subj,
      payload,
      {
        strategy: RequestStrategy.SentinelMsg,
      },
    );

    (async () => {
      let gotFirst = false;
      let badServer = false;
      let badRequest: string | undefined;
      for await (const m of raw) {
        if (!gotFirst) {
          gotFirst = true;
          const code = m.headers?.code || 0;
          if (code !== 0 && code < 200 || code > 299) {
            badRequest = m.headers?.description.toLowerCase();
            break;
          }
          // inspect the message and make sure that we have a supported server
          const v = m.headers?.get("Nats-Num-Pending");
          if (v === "") {
            badServer = true;
            break;
          }
        }
        if (m.data.length === 0) {
          break;
        }
        iter.push(new DirectMsgImpl(m));
      }
      //@ts-ignore: term function
      iter.push((): void => {
        if (badServer) {
          throw new Error("batch direct get not supported by the server");
        }
        if (badRequest) {
          throw new Error(`bad request: ${badRequest}`);
        }
        iter.stop();
      });
    })();

    return Promise.resolve(iter);
  }
}

export class DirectMsgImpl implements DirectMsg {
  data: Uint8Array;
  header: MsgHdrs;
  static jc?: Codec<unknown>;

  constructor(m: Msg) {
    if (!m.headers) {
      throw new Error("headers expected");
    }
    this.data = m.data;
    this.header = m.headers;
  }

  get subject(): string {
    return this.header.last(DirectMsgHeaders.Subject);
  }

  get seq(): number {
    const v = this.header.last(DirectMsgHeaders.Sequence);
    return typeof v === "string" ? parseInt(v) : 0;
  }

  get time(): Date {
    return new Date(Date.parse(this.timestamp));
  }

  get timestamp(): string {
    return this.header.last(DirectMsgHeaders.TimeStamp);
  }

  get stream(): string {
    return this.header.last(DirectMsgHeaders.Stream);
  }

  json<T = unknown>(reviver?: ReviverFn): T {
    return JSON.parse(new TextDecoder().decode(this.data), reviver);
  }

  string(): string {
    return TD.decode(this.data);
  }
}
