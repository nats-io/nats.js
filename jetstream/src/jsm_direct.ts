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
import type {
  DirectMsg,
  DirectStreamAPI,
  JetStreamOptions,
  StoredMsg,
} from "./types.ts";
import { DirectMsgHeaders } from "./types.ts";
import type {
  CallbackFn,
  Codec,
  Msg,
  MsgHdrs,
  NatsConnection,
  QueuedIterator,
  ReviverFn,
} from "@nats-io/nats-core/internal";
import {
  createInbox,
  Empty,
  Feature,
  QueuedIteratorImpl,
  TD,
} from "@nats-io/nats-core/internal";
import type {
  DirectBatchOptions,
  DirectLastFor,
  DirectMsgRequest,
  Done,
  LastForMsgRequest,
} from "./jsapi_types.ts";
import { validateStreamName } from "./jsutil.ts";
import { JetStreamStatus } from "./jserrors.ts";

export class DirectStreamAPIImpl extends BaseApiClientImpl
  implements DirectStreamAPI {
  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    super(nc, opts);
  }

  async getMessage(
    stream: string,
    query: DirectMsgRequest,
  ): Promise<StoredMsg | null> {
    validateStreamName(stream);

    if ("start_time" in query) {
      const { min, ok } = this.nc.features.get(Feature.JS_BATCH_DIRECT_GET);
      if (!ok) {
        throw new Error(`start_time direct option require server ${min}`);
      }
    }

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
      { timeout: this.timeout },
    );

    if (r.headers?.code !== 0) {
      const status = new JetStreamStatus(r);
      if (status.isMessageNotFound()) {
        return Promise.resolve(null);
      } else {
        return Promise.reject(status.toError());
      }
    }

    const dm = new DirectMsgImpl(r);
    return Promise.resolve(dm);
  }

  getBatch(
    stream: string,
    opts: DirectBatchOptions,
  ): Promise<QueuedIterator<StoredMsg>> {
    opts.batch = opts.batch || 1024;
    return this.get(stream, opts);
  }

  getLastMessagesFor(
    stream: string,
    opts: DirectLastFor,
  ): Promise<QueuedIterator<StoredMsg>> {
    return this.get(stream, opts);
  }

  get(
    stream: string,
    opts: DirectBatchOptions | DirectLastFor,
  ): Promise<QueuedIterator<StoredMsg>> {
    const { min, ok } = this.nc.features.get(Feature.JS_BATCH_DIRECT_GET);
    if (!ok) {
      throw new Error(`batch direct require server ${min}`);
    }
    validateStreamName(stream);
    const callback = typeof opts.callback === "function" ? opts.callback : null;
    const iter = new QueuedIteratorImpl<StoredMsg>();

    function pushIter(
      done: Done | null,
      d: StoredMsg | CallbackFn,
    ) {
      if (done) {
        iter.push(() => {
          done.err ? iter.stop(done.err) : iter.stop();
        });
        return;
      }
      iter.push(d);
    }

    function pushCb(
      done: Done | null,
      m: StoredMsg | CallbackFn,
    ) {
      const cb = callback!;
      if (typeof m === "function") {
        m();
        return;
      }
      cb(done, m);
    }

    if (callback) {
      iter.iterClosed.then((err) => {
        push({ err: err ? err : undefined }, {} as StoredMsg);
        sub.unsubscribe();
      });
    }

    const push = callback ? pushCb : pushIter;

    const inbox = createInbox(this.nc.options.inboxPrefix);
    let batchSupported = false;
    const sub = this.nc.subscribe(inbox, {
      timeout: 5000,
      callback: (err, msg) => {
        if (err) {
          iter.stop(err);
          sub.unsubscribe();
          return;
        }
        const status = JetStreamStatus.maybeParseStatus(msg);
        if (status) {
          if (status.isEndOfBatch()) {
            push({}, () => {
              iter.stop();
            });
          } else {
            const err = status.toError();
            push({ err }, () => {
              iter.stop(err);
            });
          }
          return;
        }
        if (!batchSupported) {
          if (typeof msg.headers?.get("Nats-Num-Pending") !== "string") {
            // no batch/max_bytes option was provided, so single response
            sub.unsubscribe();
            push({}, () => {
              iter.stop();
            });
          } else {
            batchSupported = true;
          }
        }

        push(null, new DirectMsgImpl(msg));
      },
    });

    const pre = this.opts.apiPrefix || "$JS.API";
    const subj = `${pre}.DIRECT.GET.${stream}`;

    const payload = JSON.stringify(opts, (key, value) => {
      if (
        (key === "up_to_time" || key === "start_time") && value instanceof Date
      ) {
        return value.toISOString();
      }
      return value;
    });
    this.nc.publish(subj, payload, { reply: inbox });

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

  get lastSequence(): number {
    const v = this.header.last(DirectMsgHeaders.LastSequence);
    return typeof v === "string" ? parseInt(v) : 0;
  }

  json<T = unknown>(reviver?: ReviverFn): T {
    return JSON.parse(new TextDecoder().decode(this.data), reviver);
  }

  string(): string {
    return TD.decode(this.data);
  }
}
