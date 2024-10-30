/*
 * Copyright 2022-2024 The NATS Authors
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
import { ConsumerAPIImpl } from "./jsmconsumer_api.ts";
import { delay, Empty, QueuedIteratorImpl } from "@nats-io/nats-core/internal";

import { ConsumersImpl, StreamAPIImpl, StreamsImpl } from "./jsmstream_api.ts";

import type {
  Advisory,
  AdvisoryKind,
  ConsumerAPI,
  Consumers,
  DirectStreamAPI,
  JetStreamClient,
  JetStreamManager,
  JetStreamManagerOptions,
  JetStreamOptions,
  JetStreamPublishOptions,
  PubAck,
  StreamAPI,
  Streams,
} from "./types.ts";
import { errors, headers } from "@nats-io/nats-core/internal";

import type {
  Msg,
  NatsConnection,
  Payload,
  RequestOptions,
} from "@nats-io/nats-core/internal";
import { PubHeaders } from "./jsapi_types.ts";
import type {
  AccountInfoResponse,
  ApiResponse,
  JetStreamAccountStats,
} from "./jsapi_types.ts";
import { DirectStreamAPIImpl } from "./jsm.ts";
import { JetStreamError } from "./jserrors.ts";

export function toJetStreamClient(
  nc: NatsConnection | JetStreamClient,
): JetStreamClient {
  //@ts-ignore: see if we have a nc
  if (typeof nc.nc === "undefined") {
    return jetstream(nc as NatsConnection);
  }
  return nc as JetStreamClient;
}

/**
 * Returns a {@link JetStreamClient} supported by the specified NatsConnection
 * @param nc
 * @param opts
 */
export function jetstream(
  nc: NatsConnection,
  opts: JetStreamManagerOptions = {},
): JetStreamClient {
  return new JetStreamClientImpl(nc, opts);
}

/**
 * Returns a {@link JetStreamManager} supported by the specified NatsConnection
 * @param nc
 * @param opts
 */
export async function jetstreamManager(
  nc: NatsConnection,
  opts: JetStreamOptions | JetStreamManagerOptions = {},
): Promise<JetStreamManager> {
  const adm = new JetStreamManagerImpl(nc, opts);
  if ((opts as JetStreamManagerOptions).checkAPI !== false) {
    try {
      await adm.getAccountInfo();
    } catch (err) {
      if (
        err instanceof errors.RequestError &&
        err.message.includes("no responders")
      ) {
        throw new JetStreamError("jetstream is not enabled", err);
      }
      throw new JetStreamError((err as Error).message, err as Error);
    }
  }
  return adm;
}

export class JetStreamManagerImpl extends BaseApiClientImpl
  implements JetStreamManager {
  streams: StreamAPI;
  consumers: ConsumerAPI;
  direct: DirectStreamAPI;

  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    super(nc, opts);
    this.streams = new StreamAPIImpl(nc, opts);
    this.consumers = new ConsumerAPIImpl(nc, opts);
    this.direct = new DirectStreamAPIImpl(nc, opts);
  }

  async getAccountInfo(): Promise<JetStreamAccountStats> {
    const r = await this._request(`${this.prefix}.INFO`);
    return r as AccountInfoResponse;
  }

  jetstream(): JetStreamClient {
    return jetstream(this.nc, this.getOptions());
  }

  advisories(): AsyncIterable<Advisory> {
    const iter = new QueuedIteratorImpl<Advisory>();
    this.nc.subscribe(`$JS.EVENT.ADVISORY.>`, {
      callback: (err, msg) => {
        if (err) {
          throw err;
        }
        try {
          const d = this.parseJsResponse(msg) as ApiResponse;
          const chunks = d.type.split(".");
          const kind = chunks[chunks.length - 1];
          iter.push({ kind: kind as AdvisoryKind, data: d });
        } catch (err) {
          iter.stop(err as Error);
        }
      },
    });

    return iter;
  }
}

export class JetStreamClientImpl extends BaseApiClientImpl
  implements JetStreamClient {
  consumers: Consumers;
  streams: Streams;
  consumerAPI: ConsumerAPI;
  streamAPI: StreamAPIImpl;
  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    super(nc, opts);
    this.consumerAPI = new ConsumerAPIImpl(nc, opts);
    this.streamAPI = new StreamAPIImpl(nc, opts);
    this.consumers = new ConsumersImpl(this.consumerAPI);
    this.streams = new StreamsImpl(this.streamAPI);
  }

  jetstreamManager(checkAPI?: boolean): Promise<JetStreamManager> {
    if (checkAPI === undefined) {
      checkAPI = (this.opts as JetStreamManagerOptions).checkAPI;
    }
    const opts = Object.assign(
      {},
      this.opts,
      { checkAPI },
    ) as JetStreamManagerOptions;
    return jetstreamManager(this.nc, opts);
  }

  get apiPrefix(): string {
    return this.prefix;
  }

  async publish(
    subj: string,
    data: Payload = Empty,
    opts?: Partial<JetStreamPublishOptions>,
  ): Promise<PubAck> {
    opts = opts || {};
    opts.expect = opts.expect || {};
    const mh = opts?.headers || headers();
    if (opts) {
      if (opts.msgID) {
        mh.set(PubHeaders.MsgIdHdr, opts.msgID);
      }
      if (opts.expect.lastMsgID) {
        mh.set(PubHeaders.ExpectedLastMsgIdHdr, opts.expect.lastMsgID);
      }
      if (opts.expect.streamName) {
        mh.set(PubHeaders.ExpectedStreamHdr, opts.expect.streamName);
      }
      if (typeof opts.expect.lastSequence === "number") {
        mh.set(PubHeaders.ExpectedLastSeqHdr, `${opts.expect.lastSequence}`);
      }
      if (typeof opts.expect.lastSubjectSequence === "number") {
        mh.set(
          PubHeaders.ExpectedLastSubjectSequenceHdr,
          `${opts.expect.lastSubjectSequence}`,
        );
      }
    }

    const to = opts.timeout || this.timeout;
    const ro = {} as RequestOptions;
    if (to) {
      ro.timeout = to;
    }
    if (opts) {
      ro.headers = mh;
    }

    let { retries, retry_delay } = opts as {
      retries: number;
      retry_delay: number;
    };
    retries = retries || 1;
    retry_delay = retry_delay || 250;

    let r: Msg;
    for (let i = 0; i < retries; i++) {
      try {
        r = await this.nc.request(subj, data, ro);
        // if here we succeeded
        break;
      } catch (err) {
        if (
          err instanceof errors.RequestError &&
          err.message.includes("no responders")
        ) {
          await delay(retry_delay);
        } else {
          throw err;
        }
      }
    }
    const pa = this.parseJsResponse(r!) as PubAck;
    if (pa.stream === "") {
      throw new JetStreamError("invalid ack response");
    }
    pa.duplicate = pa.duplicate ? pa.duplicate : false;
    return pa;
  }
}
