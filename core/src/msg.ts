/*
 * Copyright 2020-2024 The NATS Authors
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
import { MsgHdrsImpl } from "./headers.ts";
import type { MsgArg } from "./parser.ts";
import { Empty, TD } from "./encoders.ts";
import type {
  Msg,
  MsgHdrs,
  Payload,
  Publisher,
  RequestInfo,
  ReviverFn,
} from "./core.ts";
import { ErrorCode, NatsError } from "./core.ts";

export function isRequestError(msg: Msg): NatsError | null {
  // NATS core only considers errors 503s on messages that have no payload
  // everything else simply forwarded as part of the message and is considered
  // application level information
  if (msg && msg.data.length === 0 && msg.headers?.code === 503) {
    return NatsError.errorForCode(ErrorCode.NoResponders);
  }
  return null;
}

export class MsgImpl implements Msg {
  _headers?: MsgHdrs;
  _msg: MsgArg;
  _rdata: Uint8Array;
  _reply!: string;
  _subject!: string;
  publisher: Publisher;

  constructor(msg: MsgArg, data: Uint8Array, publisher: Publisher) {
    this._msg = msg;
    this._rdata = data;
    this.publisher = publisher;
  }

  get subject(): string {
    if (this._subject) {
      return this._subject;
    }
    this._subject = TD.decode(this._msg.subject);
    return this._subject;
  }

  get reply(): string {
    if (this._reply) {
      return this._reply;
    }
    this._reply = TD.decode(this._msg.reply);
    return this._reply;
  }

  get sid(): number {
    return this._msg.sid;
  }

  get headers(): MsgHdrs | undefined {
    if (this._msg.hdr > -1 && !this._headers) {
      const buf = this._rdata.subarray(0, this._msg.hdr);
      this._headers = MsgHdrsImpl.decode(buf);
    }
    return this._headers;
  }

  get data(): Uint8Array {
    if (!this._rdata) {
      return new Uint8Array(0);
    }
    return this._msg.hdr > -1
      ? this._rdata.subarray(this._msg.hdr)
      : this._rdata;
  }

  // eslint-ignore-next-line @typescript-eslint/no-explicit-any
  respond(
    data: Payload = Empty,
    opts?: { headers?: MsgHdrs; reply?: string },
  ): boolean {
    if (this.reply) {
      this.publisher.publish(this.reply, data, opts);
      return true;
    }
    return false;
  }

  size(): number {
    const subj = this._msg.subject.length;
    const reply = this._msg.reply?.length || 0;
    const payloadAndHeaders = this._msg.size === -1 ? 0 : this._msg.size;
    return subj + reply + payloadAndHeaders;
  }

  json<T = unknown>(reviver?: ReviverFn): T {
    return JSON.parse(this.string(), reviver);
  }

  string(): string {
    return TD.decode(this.data);
  }

  requestInfo(): RequestInfo | null {
    const v = this.headers?.get("Nats-Request-Info");
    if (v) {
      return JSON.parse(
        v,
        function (this: unknown, key: string, value: unknown): unknown {
          if ((key === "start" || key === "stop") && value !== "") {
            return new Date(Date.parse(value as string));
          }
          return value;
        },
      ) as RequestInfo;
    }
    return null;
  }
}
