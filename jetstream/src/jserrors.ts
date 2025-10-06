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
import { type Heartbeat, JsHeaders } from "./types.ts";
import type { ApiError } from "./jsapi_types.ts";

export class JetStreamNotEnabled extends Error {
  constructor(message: string, opts?: ErrorOptions) {
    super(message, opts);
    this.name = "JetStreamNotEnabled";
  }
}

export class JetStreamError extends Error {
  constructor(message: string, opts?: ErrorOptions) {
    super(message, opts);
    this.name = "JetStreamError";
  }
}

export class JetStreamStatusError extends JetStreamError {
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

  static maybeParseStatus(msg: Msg): JetStreamStatus | null {
    const status = new JetStreamStatus(msg);
    return status.code === 0 ? null : status;
  }

  toError(): JetStreamStatusError {
    return new JetStreamStatusError(this.description, this.code);
  }

  debug() {
    console.log({
      subject: this.msg.subject,
      reply: this.msg.reply,
      description: this.description,
      status: this.code,
      headers: this.msg.headers,
    });
  }

  get code(): number {
    return this.msg.headers?.code || 0;
  }

  get description(): string {
    if (this._description === "") {
      this._description = this.msg.headers?.description?.toLowerCase() || "";
      if (this._description === "") {
        this._description = this.code === 503 ? "no responders" : "unknown";
      }
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
    | Heartbeat
    | null {
    if (this.isIdleHeartbeat()) {
      return {
        type: "heartbeat",
        lastConsumerSequence: parseInt(
          this.msg.headers?.get("Nats-Last-Consumer") || "0",
        ),
        lastStreamSequence: parseInt(
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

  isBadRequest(): boolean {
    return this.code === 400;
  }

  isConsumerDeleted(): boolean {
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
      this.isExceededMaxRequestBatch() || this.isMessageSizeExceedsMaxBytes();
  }

  isMessageNotFound(): boolean {
    return this.code === 404 && this.description === "message not found";
  }

  isNoResults(): boolean {
    return this.code === 404 && this.description === "no results";
  }

  isMessageSizeExceedsMaxBytes(): boolean {
    return this.code === 409 &&
      this.description === "message size exceeds maxbytes";
  }

  isEndOfBatch(): boolean {
    return this.code === 204 && this.description === "eob";
  }
}

export const JetStreamApiCodes = {
  ConsumerNotFound: 10014,
  StreamNotFound: 10059,
  JetStreamNotEnabledForAccount: 10039,
  StreamWrongLastSequence: 10071,
  NoMessageFound: 10037,
} as const;

export type JetStreamApiCodes =
  typeof JetStreamApiCodes[keyof typeof JetStreamApiCodes];

export function isMessageNotFound(err: Error): boolean {
  return err instanceof JetStreamApiError &&
    err.code === JetStreamApiCodes.NoMessageFound;
}

export class InvalidNameError extends Error {
  constructor(message: string = "", opts?: ErrorOptions) {
    super(message, opts);
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

export class ConsumerNotFoundError extends JetStreamApiError {
  constructor(jsErr: ApiError, opts?: ErrorOptions) {
    super(jsErr, opts);
    this.name = "ConsumerNotFoundError";
  }
}

export class StreamNotFoundError extends JetStreamApiError {
  constructor(jsErr: ApiError, opts?: ErrorOptions) {
    super(jsErr, opts);
    this.name = "StreamNotFoundError";
  }

  static fromMessage(message: string): JetStreamApiError {
    return new StreamNotFoundError({
      err_code: JetStreamApiCodes.StreamNotFound,
      description: message,
      code: 404,
    });
  }
}

export const jserrors = {
  InvalidNameError,
  ConsumerNotFoundError,
  StreamNotFoundError,
  JetStreamError,
  JetStreamApiError,
  JetStreamNotEnabled,
};
