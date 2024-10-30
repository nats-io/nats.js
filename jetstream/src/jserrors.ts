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

import type { Msg } from "@nats-io/nats-core";
import { JsHeaders } from "./types.ts";
import type { ApiError } from "./jsapi_types.ts";

export class JetStreamStatusError extends Error {
  code: number;
  constructor(message: string, code: number, opts?: ErrorOptions) {
    super(message, opts);
    this.code = code;
    this.name = "JetStreamStatusError";
  }
}

export class JetStreamStatus {
  msg: Msg;
  _description: string;

  constructor(msg: Msg) {
    this.msg = msg;
    this._description = "";
  }

  toError(): JetStreamStatusError {
    return new JetStreamStatusError(this.description, this.code);
  }

  debug() {
    console.log({
      message: this.description,
      status: this.code,
      headers: this.msg.headers,
    });
  }

  get code(): number {
    return this.msg.headers?.code || 0;
  }

  get description(): string {
    if (this._description === "") {
      this._description = this.msg.headers?.description?.toLowerCase() ||
        "unknown";
    }
    return this._description;
  }

  isIdleHeartbeat(): boolean {
    return this.code === 100 && this.description === "idle heartbeat";
  }

  isFlowControlRequest(): boolean {
    return this.code === 100 && this.description === "flowcontrol request";
  }

  parseHeartbeat():
    | { natsLastConsumer: number; natsLastStream: number }
    | null {
    if (this.isIdleHeartbeat()) {
      return {
        natsLastConsumer: parseInt(
          this.msg.headers?.get("Nats-Last-Consumer") || "0",
        ),
        natsLastStream: parseInt(
          this.msg.headers?.get("Nats-Last-Stream") || "0",
        ),
      };
    }
    return null;
  }

  isRequestTimeout(): boolean {
    return this.code === 408 && this.description === "request timeout";
  }

  parseDiscard(): { msgsLeft: number; bytesLeft: number } {
    const discard = {
      msgsLeft: 0,
      bytesLeft: 0,
    };
    const msgsLeft = this.msg.headers?.get(JsHeaders.PendingMessagesHdr);
    if (msgsLeft) {
      discard.msgsLeft = parseInt(msgsLeft);
    }
    const bytesLeft = this.msg.headers?.get(JsHeaders.PendingBytesHdr);
    if (bytesLeft) {
      discard.bytesLeft = parseInt(bytesLeft);
    }

    return discard;
  }

  isBadRequest() {
    return this.code === 400;
  }

  isConsumerDeleted() {
    return this.code === 409 && this.description === "consumer deleted";
  }

  isStreamDeleted(): boolean {
    return this.code === 409 && this.description === "stream deleted";
  }

  isIdleHeartbeatMissed(): boolean {
    return this.code === 409 && this.description === "idle heartbeats missed";
  }

  isMaxWaitingExceeded(): boolean {
    return this.code === 409 && this.description === "exceeded maxwaiting";
  }

  isConsumerIsPushBased(): boolean {
    return this.code === 409 && this.description === "consumer is push based";
  }

  isExceededMaxWaiting(): boolean {
    return this.code === 409 &&
      this.description.includes("exceeded maxwaiting");
  }

  isExceededMaxRequestBatch(): boolean {
    return this.code === 409 &&
      this.description.includes("exceeded maxrequestbatch");
  }

  isExceededMaxExpires(): boolean {
    return this.code === 409 &&
      this.description.includes("exceeded maxrequestexpires");
  }

  isExceededLimit(): boolean {
    return this.isExceededMaxExpires() || this.isExceededMaxWaiting() ||
      this.isExceededMaxRequestBatch();
  }

  isMessageNotFound(): boolean {
    return this.code === 404 && this.description === "message not found";
  }
}

export class JetStreamError extends Error {
  constructor(message: string, opts?: ErrorOptions) {
    super(message, opts);
    this.name = "JetStreamError";
  }
}

export enum JetStreamApiCodes {
  ConsumerNotFound = 10014,
  StreamNotFound = 10059,
  JetStreamNotEnabledForAccount = 10039,
  StreamWrongLastSequence = 10071,
  NoMessageFound = 10037,
}

export function isMessageNotFound(err: Error): boolean {
  return err instanceof JetStreamApiError &&
    err.code === JetStreamApiCodes.NoMessageFound;
}

export class MessageNotFoundError extends Error {
  constructor(message: string, opts?: ErrorOptions) {
    super(message, opts);
    this.name = "MessageNotFoundError";
  }
}

export class ConsumerNotFoundError extends Error {
  stream: string;
  consumer: string;
  constructor(stream: string, consumer: string, opts?: ErrorOptions) {
    super(`consumer not found`, opts);
    this.stream = stream;
    this.consumer = consumer;
    this.name = "ConsumerNotFoundError";
  }
}

export class StreamNotFoundError extends Error {
  stream: string;
  constructor(stream: string, opts?: ErrorOptions) {
    super(`stream not found`, opts);
    this.stream = stream;
    this.name = "StreamNotFoundError";
  }
}

export class InvalidNameError extends Error {
  constructor(name: string, message: string = "", opts?: ErrorOptions) {
    super(`'${name} ${message}`, opts);
    this.name = "InvalidNameError";
  }
}

export class JetStreamApiError extends Error {
  #apiError: ApiError;

  constructor(jsErr: ApiError, opts?: ErrorOptions) {
    super(jsErr.description, opts);
    this.#apiError = jsErr;
    this.name = "JetStreamApiError";
  }

  get code(): number {
    return this.#apiError.err_code;
  }

  get status(): number {
    return this.#apiError.code;
  }

  apiError(): ApiError {
    return Object.assign({}, this.#apiError);
  }
}

export const jserrors = {
  InvalidNameError,
  ConsumerNotFoundError,
  StreamNotFoundError,
  JetStreamError,
};
