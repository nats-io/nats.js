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

import type {
  Msg,
  MsgHdrs,
  MsgImpl,
  ProtocolHandler,
  RequestOptions,
} from "@nats-io/nats-core/internal";
import {
  DataBuffer,
  deferred,
  millis,
  nanos,
  RequestOne,
} from "@nats-io/nats-core/internal";
import type { DeliveryInfo, PullOptions } from "./jsapi_types.ts";

export const ACK = Uint8Array.of(43, 65, 67, 75);
const NAK = Uint8Array.of(45, 78, 65, 75);
const WPI = Uint8Array.of(43, 87, 80, 73);
const NXT = Uint8Array.of(43, 78, 88, 84);
const TERM = Uint8Array.of(43, 84, 69, 82, 77);
const SPACE = Uint8Array.of(32);

/**
 * Represents a message stored in JetStream
 */
export type JsMsg = {
  /**
   * True if the message was redelivered
   */
  redelivered: boolean;
  /**
   * The delivery info for the message
   */
  info: DeliveryInfo;
  /**
   * The sequence number for the message
   */
  seq: number;
  /**
   * Any headers associated with the message
   */
  headers: MsgHdrs | undefined;
  /**
   * The message's data
   */
  data: Uint8Array;
  /**
   * The subject on which the message was published
   */
  subject: string;
  /**
   * @ignore
   */
  sid: number;

  /**
   * The time the message was received
   */
  time: Date;

  /**
   * The time the message was received as an ISO formatted date string
   */
  timestamp: string;

  /**
   * Indicate to the JetStream server that the message was processed
   * successfully.
   */
  ack(): void;

  /**
   * Indicate to the JetStream server that processing of the message
   * failed, and that it should be resent after the specified number of
   * milliseconds.
   * @param millis
   */
  nak(millis?: number): void;

  /**
   * Indicate to the JetStream server that processing of the message
   * is on going, and that the ack wait timer for the message should be
   * reset preventing a redelivery.
   */
  working(): void;

  /**
   * !! this is an experimental feature - and could be removed
   *
   * next() combines ack() and pull(), requires the subject for a
   * subscription processing to process a message is provided
   * (can be the same) however, because the ability to specify
   * how long to keep the request open can be specified, this
   * functionality doesn't work well with iterators, as an error
   * (408s) are expected and needed to re-trigger a pull in case
   * there was a timeout. In an iterator, the error will close
   * the iterator, requiring a subscription to be reset.
   */
  next(subj: string, ro?: Partial<PullOptions>): void;

  /**
   * Indicate to the JetStream server that processing of the message
   * failed and that the message should not be sent to the consumer again.
   * @param reason is a string describing why the message was termed. Note
   * that `reason` is only available on servers 2.11.0 or better.
   */
  term(reason?: string): void;

  /**
   * Indicate to the JetStream server that the message was processed
   * successfully and that the JetStream server should acknowledge back
   * that the acknowledgement was received.
   * @param opts are optional options (currently only a timeout value
   * if not specified uses the timeout specified in the JetStreamOptions
   * when creating the JetStream context.
   */
  ackAck(opts?: Partial<{ timeout: number }>): Promise<boolean>;

  /**
   * Convenience method to parse the message payload as JSON. This method
   * will throw an exception if there's a parsing error;
   */
  json<T>(): T;

  /**
   * Convenience method to parse the message payload as string. This method
   * may throw an exception if there's a conversion error
   */
  string(): string;
};

export function toJsMsg(m: Msg, ackTimeout = 5000): JsMsg {
  return new JsMsgImpl(m, ackTimeout);
}

export function parseInfo(s: string): DeliveryInfo {
  const tokens = s.split(".");
  if (tokens.length === 9) {
    tokens.splice(2, 0, "_", "");
  }

  if (
    (tokens.length < 11) || tokens[0] !== "$JS" || tokens[1] !== "ACK"
  ) {
    throw new Error(`unable to parse delivery info - not a jetstream message`);
  }

  // old
  // "$JS.ACK.<stream>.<consumer>.<deliveryCount><streamSeq><deliverySequence>.<timestamp>.<pending>"
  // new
  // $JS.ACK.<domain>.<accounthash>.<stream>.<consumer>.<deliveryCount>.<streamSeq>.<deliverySequence>.<timestamp>.<pending>.<random>
  const di = {} as DeliveryInfo;
  // if domain is "_", replace with blank
  di.domain = tokens[2] === "_" ? "" : tokens[2];
  di.account_hash = tokens[3];
  di.stream = tokens[4];
  di.consumer = tokens[5];
  di.deliveryCount = parseInt(tokens[6], 10);
  di.redelivered = di.deliveryCount > 1;
  di.streamSequence = parseInt(tokens[7], 10);
  di.deliverySequence = parseInt(tokens[8], 10);
  di.timestampNanos = parseInt(tokens[9], 10);
  di.pending = parseInt(tokens[10], 10);
  return di;
}

export class JsMsgImpl implements JsMsg {
  msg: Msg;
  di?: DeliveryInfo;
  didAck: boolean;
  timeout: number;

  constructor(msg: Msg, timeout: number) {
    this.msg = msg;
    this.didAck = false;
    this.timeout = timeout;
  }

  get subject(): string {
    return this.msg.subject;
  }

  get sid(): number {
    return this.msg.sid;
  }

  get data(): Uint8Array {
    return this.msg.data;
  }

  get headers(): MsgHdrs {
    return this.msg.headers!;
  }

  get info(): DeliveryInfo {
    if (!this.di) {
      this.di = parseInfo(this.reply);
    }
    return this.di;
  }

  get redelivered(): boolean {
    return this.info.deliveryCount > 1;
  }

  get reply(): string {
    return this.msg.reply || "";
  }

  get seq(): number {
    return this.info.streamSequence;
  }

  get time(): Date {
    const ms = millis(this.info.timestampNanos);
    return new Date(ms);
  }

  get timestamp(): string {
    return this.time.toISOString();
  }

  doAck(payload: Uint8Array) {
    if (!this.didAck) {
      // all acks are final with the exception of +WPI
      this.didAck = !this.isWIP(payload);
      this.msg.respond(payload);
    }
  }

  isWIP(p: Uint8Array) {
    return p.length === 4 && p[0] === WPI[0] && p[1] === WPI[1] &&
      p[2] === WPI[2] && p[3] === WPI[3];
  }

  // this has to dig into the internals as the message has access
  // to the protocol but not the high-level client.
  async ackAck(opts?: Partial<{ timeout: number }>): Promise<boolean> {
    const d = deferred<boolean>();
    if (!this.didAck) {
      this.didAck = true;
      if (this.msg.reply) {
        opts = opts || {};
        opts.timeout = opts.timeout || this.timeout;
        const mi = this.msg as MsgImpl;
        const proto = mi.publisher as unknown as ProtocolHandler;
        const trace = !(proto.options?.noAsyncTraces || false);
        const r = new RequestOne(proto.muxSubscriptions, this.msg.reply, {
          timeout: opts.timeout,
        }, trace);
        proto.request(r);
        try {
          proto.publish(
            this.msg.reply,
            ACK,
            {
              reply: `${proto.muxSubscriptions.baseInbox}${r.token}`,
            },
          );
        } catch (err) {
          r.cancel(err as Error);
        }
        try {
          await Promise.race([r.timer, r.deferred]);
          d.resolve(true);
        } catch (err) {
          r.cancel(err as Error);
          d.reject(err);
        }
      } else {
        d.resolve(false);
      }
    } else {
      d.resolve(false);
    }
    return d;
  }

  ack() {
    this.doAck(ACK);
  }

  nak(millis?: number) {
    let payload: Uint8Array | string = NAK;
    if (millis) {
      payload = new TextEncoder().encode(
        `-NAK ${JSON.stringify({ delay: nanos(millis) })}`,
      );
    }
    this.doAck(payload);
  }

  working() {
    this.doAck(WPI);
  }

  next(subj: string, opts: Partial<PullOptions> = { batch: 1 }) {
    const args: Partial<PullOptions> = {};
    args.batch = opts.batch || 1;
    args.no_wait = opts.no_wait || false;
    if (opts.expires && opts.expires > 0) {
      args.expires = nanos(opts.expires);
    }
    const data = new TextEncoder().encode(JSON.stringify(args));
    const payload = DataBuffer.concat(NXT, SPACE, data);
    const reqOpts = subj ? { reply: subj } as RequestOptions : undefined;
    this.msg.respond(payload, reqOpts);
  }

  term(reason = "") {
    let term = TERM;
    if (reason?.length > 0) {
      term = new TextEncoder().encode(`+TERM ${reason}`) as Uint8Array<
        ArrayBuffer
      >;
    }
    this.doAck(term);
  }

  json<T = unknown>(): T {
    return this.msg.json();
  }

  string(): string {
    return this.msg.string();
  }
}
