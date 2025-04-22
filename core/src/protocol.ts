/*
 * Copyright 2018-2024 The NATS Authors
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
import { decode, Empty, encode, TE } from "./encoders.ts";
import type { Transport } from "./transport.ts";
import { CR_LF, CRLF, getResolveFn, newTransport } from "./transport.ts";
import type { Deferred, Delay, Timeout } from "./util.ts";
import { deferred, delay, extend, timeout } from "./util.ts";
import { DataBuffer } from "./databuffer.ts";
import type { ServerImpl } from "./servers.ts";
import { Servers } from "./servers.ts";
import { QueuedIteratorImpl } from "./queued_iterator.ts";
import type { MsgHdrsImpl } from "./headers.ts";
import { MuxSubscription } from "./muxsubscription.ts";
import type { PH } from "./heartbeats.ts";
import { Heartbeat } from "./heartbeats.ts";
import type { MsgArg, ParserEvent } from "./parser.ts";
import { Kind, Parser } from "./parser.ts";
import { MsgImpl } from "./msg.ts";
import { Features, parseSemVer } from "./semver.ts";
import type {
  ConnectionOptions,
  Dispatcher,
  Msg,
  Payload,
  Publisher,
  PublishOptions,
  Request,
  Server,
  ServerInfo,
  Status,
  Subscription,
  SubscriptionOptions,
} from "./core.ts";

import {
  DEFAULT_MAX_PING_OUT,
  DEFAULT_PING_INTERVAL,
  DEFAULT_RECONNECT_TIME_WAIT,
} from "./options.ts";
import { errors, InvalidArgumentError } from "./errors.ts";

import type {
  AuthorizationError,
  PermissionViolationError,
  UserAuthenticationExpiredError,
} from "./errors.ts";

const FLUSH_THRESHOLD = 1024 * 32;

export const INFO = /^INFO\s+([^\r\n]+)\r\n/i;

const PONG_CMD = encode("PONG\r\n");
const PING_CMD = encode("PING\r\n");

export class Connect {
  echo?: boolean;
  no_responders?: boolean;
  protocol: number;
  verbose?: boolean;
  pedantic?: boolean;
  jwt?: string;
  nkey?: string;
  sig?: string;
  user?: string;
  pass?: string;
  auth_token?: string;
  tls_required?: boolean;
  name?: string;
  lang: string;
  version: string;
  headers?: boolean;

  constructor(
    transport: { version: string; lang: string },
    opts: ConnectionOptions,
    nonce?: string,
  ) {
    this.protocol = 1;
    this.version = transport.version;
    this.lang = transport.lang;
    this.echo = opts.noEcho ? false : undefined;
    this.verbose = opts.verbose;
    this.pedantic = opts.pedantic;
    this.tls_required = opts.tls ? true : undefined;
    this.name = opts.name;

    const creds =
      (opts && typeof opts.authenticator === "function"
        ? opts.authenticator(nonce)
        : {}) || {};
    extend(this, creds);
  }
}

class SlowNotifier {
  slow: number;
  cb: (pending: number) => void;
  notified: boolean;

  constructor(slow: number, cb: (pending: number) => void) {
    this.slow = slow;
    this.cb = cb;
    this.notified = false;
  }

  maybeNotify(pending: number): void {
    // if we are below the threshold reset the ability to notify
    if (pending <= this.slow) {
      this.notified = false;
    } else {
      if (!this.notified) {
        // crossed the threshold, notify and silence.
        this.cb(pending);
        this.notified = true;
      }
    }
  }
}

export class SubscriptionImpl extends QueuedIteratorImpl<Msg>
  implements Subscription {
  sid!: number;
  queue?: string;
  draining: boolean;
  max?: number;
  subject: string;
  drained?: Promise<void>;
  protocol: ProtocolHandler;
  timer?: Timeout<void>;
  info?: unknown;
  cleanupFn?: (sub: Subscription, info?: unknown) => void;
  closed: Deferred<void | Error>;
  requestSubject?: string;
  slow?: SlowNotifier;

  constructor(
    protocol: ProtocolHandler,
    subject: string,
    opts: SubscriptionOptions = {},
  ) {
    super();
    extend(this, opts);
    this.protocol = protocol;
    this.subject = subject;
    this.draining = false;
    this.noIterator = typeof opts.callback === "function";
    this.closed = deferred<void | Error>();

    const asyncTraces = !(protocol.options?.noAsyncTraces || false);

    if (opts.timeout) {
      this.timer = timeout<void>(opts.timeout, asyncTraces);
      this.timer
        .then(() => {
          // timer was cancelled
          this.timer = undefined;
        })
        .catch((err) => {
          // timer fired
          this.stop(err);
          if (this.noIterator) {
            this.callback(err, {} as Msg);
          }
        });
    }
    if (!this.noIterator) {
      // cleanup - they used break or return from the iterator
      // make sure we clean up, if they didn't call unsub
      this.iterClosed.then((err: void | Error) => {
        this.closed.resolve(err);
        this.unsubscribe();
      });
    }
  }

  setSlowNotificationFn(slow: number, fn?: (pending: number) => void): void {
    this.slow = undefined;
    if (fn) {
      if (this.noIterator) {
        throw new Error("callbacks don't support slow notifications");
      }
      this.slow = new SlowNotifier(slow, fn);
    }
  }

  callback(err: Error | null, msg: Msg) {
    this.cancelTimeout();
    err ? this.stop(err) : this.push(msg);
    if (!err && this.slow) {
      this.slow.maybeNotify(this.getPending());
    }
  }

  close(err?: Error): void {
    if (!this.isClosed()) {
      this.cancelTimeout();
      const fn = () => {
        this.stop();
        if (this.cleanupFn) {
          try {
            this.cleanupFn(this, this.info);
          } catch (_err) {
            // ignoring
          }
        }
        this.closed.resolve(err);
      };

      if (this.noIterator) {
        fn();
      } else {
        this.push(fn);
      }
    }
  }

  unsubscribe(max?: number): void {
    this.protocol.unsubscribe(this, max);
  }

  cancelTimeout(): void {
    if (this.timer) {
      this.timer.cancel();
      this.timer = undefined;
    }
  }

  drain(): Promise<void> {
    if (this.protocol.isClosed()) {
      return Promise.reject(new errors.ClosedConnectionError());
    }
    if (this.isClosed()) {
      return Promise.reject(
        new errors.InvalidOperationError("subscription is already closed"),
      );
    }
    if (!this.drained) {
      this.draining = true;
      this.protocol.unsub(this);
      this.drained = this.protocol.flush(deferred<void>())
        .then(() => {
          this.protocol.subscriptions.cancel(this);
        })
        .catch(() => {
          this.protocol.subscriptions.cancel(this);
        });
    }
    return this.drained;
  }

  isDraining(): boolean {
    return this.draining;
  }

  isClosed(): boolean {
    return this.done;
  }

  getSubject(): string {
    return this.subject;
  }

  getMax(): number | undefined {
    return this.max;
  }

  getID(): number {
    return this.sid;
  }
}

export class Subscriptions {
  mux: SubscriptionImpl | null;
  subs: Map<number, SubscriptionImpl>;
  sidCounter: number;

  constructor() {
    this.sidCounter = 0;
    this.mux = null;
    this.subs = new Map<number, SubscriptionImpl>();
  }

  size(): number {
    return this.subs.size;
  }

  add(s: SubscriptionImpl): SubscriptionImpl {
    this.sidCounter++;
    s.sid = this.sidCounter;
    this.subs.set(s.sid, s as SubscriptionImpl);
    return s;
  }

  setMux(s: SubscriptionImpl | null): SubscriptionImpl | null {
    this.mux = s;
    return s;
  }

  getMux(): SubscriptionImpl | null {
    return this.mux;
  }

  get(sid: number): SubscriptionImpl | undefined {
    return this.subs.get(sid);
  }

  resub(s: SubscriptionImpl): SubscriptionImpl {
    this.sidCounter++;
    this.subs.delete(s.sid);
    s.sid = this.sidCounter;
    this.subs.set(s.sid, s);
    return s;
  }

  all(): (SubscriptionImpl)[] {
    return Array.from(this.subs.values());
  }

  cancel(s: SubscriptionImpl): void {
    if (s) {
      s.close();
      this.subs.delete(s.sid);
    }
  }

  handleError(err: PermissionViolationError): boolean {
    const subs = this.all();
    let sub;
    if (err.operation === "subscription") {
      sub = subs.find((s) => {
        return s.subject === err.subject && s.queue === err.queue;
      });
    } else if (err.operation === "publish") {
      // we have a no mux subscription
      sub = subs.find((s) => {
        return s.requestSubject === err.subject;
      });
    }
    if (sub) {
      sub.callback(err, {} as Msg);
      sub.close(err);
      this.subs.delete(sub.sid);
      return sub !== this.mux;
    }

    return false;
  }

  close() {
    this.subs.forEach((sub) => {
      sub.close();
    });
  }
}

export class ProtocolHandler implements Dispatcher<ParserEvent> {
  connected: boolean;
  connectedOnce: boolean;
  infoReceived: boolean;
  info?: ServerInfo;
  muxSubscriptions: MuxSubscription;
  options: ConnectionOptions;
  outbound: DataBuffer;
  pongs: Array<Deferred<void>>;
  subscriptions: Subscriptions;
  transport!: Transport;
  noMorePublishing: boolean;
  connectError?: (err?: Error) => void;
  publisher: Publisher;
  _closed: boolean;
  closed: Deferred<Error | void>;
  listeners: QueuedIteratorImpl<Status>[];
  heartbeats: Heartbeat;
  parser: Parser;
  outMsgs: number;
  inMsgs: number;
  outBytes: number;
  inBytes: number;
  pendingLimit: number;
  lastError?: Error;
  abortReconnect: boolean;
  whyClosed: string;

  servers: Servers;
  server!: ServerImpl;
  features: Features;
  connectPromise: Promise<void> | null;
  dialDelay: Delay | null;
  raceTimer?: Timeout<void>;

  constructor(options: ConnectionOptions, publisher: Publisher) {
    this._closed = false;
    this.connected = false;
    this.connectedOnce = false;
    this.infoReceived = false;
    this.noMorePublishing = false;
    this.abortReconnect = false;
    this.listeners = [];
    this.pendingLimit = FLUSH_THRESHOLD;
    this.outMsgs = 0;
    this.inMsgs = 0;
    this.outBytes = 0;
    this.inBytes = 0;
    this.options = options;
    this.publisher = publisher;
    this.subscriptions = new Subscriptions();
    this.muxSubscriptions = new MuxSubscription();
    this.outbound = new DataBuffer();
    this.pongs = [];
    this.whyClosed = "";
    //@ts-ignore: options.pendingLimit is hidden
    this.pendingLimit = options.pendingLimit || this.pendingLimit;
    this.features = new Features({ major: 0, minor: 0, micro: 0 });
    this.connectPromise = null;
    this.dialDelay = null;

    const servers = typeof options.servers === "string"
      ? [options.servers]
      : options.servers;

    this.servers = new Servers(servers, {
      randomize: !options.noRandomize,
    });
    this.closed = deferred<Error | void>();
    this.parser = new Parser(this);

    this.heartbeats = new Heartbeat(
      this as PH,
      this.options.pingInterval || DEFAULT_PING_INTERVAL,
      this.options.maxPingOut || DEFAULT_MAX_PING_OUT,
    );
  }

  resetOutbound(): void {
    this.outbound.reset();
    const pongs = this.pongs;
    this.pongs = [];
    // reject the pongs - the disconnect from here shouldn't have a trace
    // because that confuses API consumers
    const err = new errors.RequestError("connection disconnected");
    err.stack = "";
    pongs.forEach((p) => {
      p.reject(err);
    });
    this.parser = new Parser(this);
    this.infoReceived = false;
  }

  dispatchStatus(status: Status): void {
    this.listeners.forEach((q) => {
      q.push(status);
    });
  }

  private prepare(): Deferred<void> {
    if (this.transport) {
      this.transport.discard();
    }
    this.info = undefined;
    this.resetOutbound();

    const pong = deferred<void>();
    pong.catch(() => {
      // provide at least one catch - as pong rejection can happen before it is expected
    });
    this.pongs.unshift(pong);

    this.connectError = (err?: Error) => {
      pong.reject(err);
    };

    this.transport = newTransport();
    this.transport.closed()
      .then(async (_err?) => {
        this.connected = false;
        if (!this.isClosed()) {
          // if the transport gave an error use that, otherwise
          // we may have received a protocol error
          await this.disconnected(this.transport.closeError || this.lastError);
          return;
        }
      });

    return pong;
  }

  public disconnect(): void {
    this.dispatchStatus({ type: "staleConnection" });
    this.transport.disconnect();
  }

  public reconnect(): Promise<void> {
    if (this.connected) {
      this.dispatchStatus({
        type: "forceReconnect",
      });
      this.transport.disconnect();
    }
    return Promise.resolve();
  }

  async disconnected(err?: Error): Promise<void> {
    this.dispatchStatus(
      {
        type: "disconnect",
        server: this.servers.getCurrentServer().toString(),
      },
    );
    if (this.options.reconnect) {
      await this.dialLoop()
        .then(() => {
          this.dispatchStatus(
            {
              type: "reconnect",
              server: this.servers.getCurrentServer().toString(),
            },
          );
          // if we are here we reconnected, but we have an authentication
          // that expired, we need to clean it up, otherwise we'll queue up
          // two of these, and the default for the client will be to
          // close, rather than attempt again - possibly they have an
          // authenticator that dynamically updates
          if (this.lastError instanceof errors.UserAuthenticationExpiredError) {
            this.lastError = undefined;
          }
        })
        .catch((err) => {
          this.close(err).catch();
        });
    } else {
      await this.close(err).catch();
    }
  }

  async dial(srv: Server): Promise<void> {
    const pong = this.prepare();
    try {
      this.raceTimer = timeout(this.options.timeout || 20000);
      const cp = this.transport.connect(srv, this.options);
      await Promise.race([cp, this.raceTimer]);
      (async () => {
        try {
          for await (const b of this.transport) {
            this.parser.parse(b);
          }
        } catch (err) {
          console.log("reader closed", err);
        }
      })().then();
    } catch (err) {
      pong.reject(err);
    }

    try {
      await Promise.race([this.raceTimer, pong]);
      this.raceTimer?.cancel();
      this.connected = true;
      this.connectError = undefined;
      this.sendSubscriptions();
      this.connectedOnce = true;
      this.server.didConnect = true;
      this.server.reconnects = 0;
      this.flushPending();
      this.heartbeats.start();
    } catch (err) {
      this.raceTimer?.cancel();
      await this.transport.close(err as Error);
      throw err;
    }
  }

  async _doDial(srv: Server): Promise<void> {
    const { resolve } = this.options;
    const alts = await srv.resolve({
      fn: getResolveFn(),
      debug: this.options.debug,
      randomize: !this.options.noRandomize,
      resolve,
    });

    let lastErr: Error | null = null;
    for (const a of alts) {
      try {
        lastErr = null;
        this.dispatchStatus(
          { type: "reconnecting" },
        );
        await this.dial(a);
        // if here we connected
        return;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    // if we are here, we failed, and we have no additional
    // alternatives for this server
    throw lastErr;
  }

  dialLoop(): Promise<void> {
    if (this.connectPromise === null) {
      this.connectPromise = this.dodialLoop();
      this.connectPromise
        .then(() => {})
        .catch(() => {})
        .finally(() => {
          this.connectPromise = null;
        });
    }
    return this.connectPromise;
  }

  async dodialLoop(): Promise<void> {
    let lastError: Error | undefined;
    while (true) {
      if (this._closed) {
        // if we are disconnected, and close is called, the client
        // still tries to reconnect - to match the reconnect policy
        // in the case of close, want to stop.
        this.servers.clear();
      }
      const wait = this.options.reconnectDelayHandler
        ? this.options.reconnectDelayHandler()
        : DEFAULT_RECONNECT_TIME_WAIT;
      let maxWait = wait;
      const srv = this.selectServer();
      if (!srv || this.abortReconnect) {
        if (lastError) {
          throw lastError;
        } else if (this.lastError) {
          throw this.lastError;
        } else {
          throw new errors.ConnectionError("connection refused");
        }
      }
      const now = Date.now();
      if (srv.lastConnect === 0 || srv.lastConnect + wait <= now) {
        srv.lastConnect = Date.now();
        try {
          await this._doDial(srv);
          break;
        } catch (err) {
          lastError = err as Error;
          if (!this.connectedOnce) {
            if (this.options.waitOnFirstConnect) {
              continue;
            }
            this.servers.removeCurrentServer();
          }
          srv.reconnects++;
          const mra = this.options.maxReconnectAttempts || 0;
          if (mra !== -1 && srv.reconnects >= mra) {
            this.servers.removeCurrentServer();
          }
        }
      } else {
        maxWait = Math.min(maxWait, srv.lastConnect + wait - now);
        this.dialDelay = delay(maxWait);
        await this.dialDelay;
      }
    }
  }

  public static async connect(
    options: ConnectionOptions,
    publisher: Publisher,
  ): Promise<ProtocolHandler> {
    const h = new ProtocolHandler(options, publisher);
    await h.dialLoop();
    return h;
  }

  static toError(s: string): Error {
    let err: Error | null = errors.PermissionViolationError.parse(s);
    if (err) {
      return err;
    }
    err = errors.UserAuthenticationExpiredError.parse(s);
    if (err) {
      return err;
    }
    err = errors.AuthorizationError.parse(s);
    if (err) {
      return err;
    }
    return new errors.ProtocolError(s);
  }

  processMsg(msg: MsgArg, data: Uint8Array) {
    this.inMsgs++;
    this.inBytes += data.length;
    if (!this.subscriptions.sidCounter) {
      return;
    }

    const sub = this.subscriptions.get(msg.sid) as SubscriptionImpl;
    if (!sub) {
      return;
    }
    sub.received += 1;

    if (sub.callback) {
      sub.callback(null, new MsgImpl(msg, data, this));
    }

    if (sub.max !== undefined && sub.received >= sub.max) {
      sub.unsubscribe();
    }
  }

  processError(m: Uint8Array) {
    let s = decode(m);
    if (s.startsWith("'") && s.endsWith("'")) {
      s = s.slice(1, s.length - 1);
    }
    const err = ProtocolHandler.toError(s);

    switch (err.constructor) {
      case errors.PermissionViolationError: {
        const pe = err as PermissionViolationError;
        const mux = this.subscriptions.getMux();
        const isMuxPermission = mux ? pe.subject === mux.subject : false;
        this.subscriptions.handleError(pe);
        this.muxSubscriptions.handleError(isMuxPermission, pe);
        if (isMuxPermission) {
          // remove the permission - enable it to be recreated
          this.subscriptions.setMux(null);
        }
      }
    }

    this.dispatchStatus({ type: "error", error: err });
    this.handleError(err);
  }

  handleError(err: Error) {
    if (
      err instanceof errors.UserAuthenticationExpiredError ||
      err instanceof errors.AuthorizationError
    ) {
      this.handleAuthError(err);
    }

    if (!(err instanceof errors.PermissionViolationError)) {
      this.lastError = err;
    }
  }

  handleAuthError(err: UserAuthenticationExpiredError | AuthorizationError) {
    if (
      (this.lastError instanceof errors.UserAuthenticationExpiredError ||
        this.lastError instanceof errors.AuthorizationError) &&
      this.options.ignoreAuthErrorAbort === false
    ) {
      this.abortReconnect = true;
    }
    if (this.connectError) {
      this.connectError(err);
    } else {
      this.disconnect();
    }
  }

  processPing() {
    this.transport.send(PONG_CMD);
  }

  processPong() {
    const cb = this.pongs.shift();
    if (cb) {
      cb.resolve();
    }
  }

  processInfo(m: Uint8Array) {
    const info = JSON.parse(decode(m));
    this.info = info;
    const updates = this.options && this.options.ignoreClusterUpdates
      ? undefined
      : this.servers.update(info, this.transport.isEncrypted());
    if (!this.infoReceived) {
      this.features.update(parseSemVer(info.version));
      this.infoReceived = true;
      if (this.transport.isEncrypted()) {
        this.servers.updateTLSName();
      }
      // send connect
      const { version, lang } = this.transport;
      try {
        const c = new Connect(
          { version, lang },
          this.options,
          info.nonce,
        );

        if (info.headers) {
          c.headers = true;
          c.no_responders = true;
        }
        const cs = JSON.stringify(c);
        this.transport.send(
          encode(`CONNECT ${cs}${CR_LF}`),
        );
        this.transport.send(PING_CMD);
      } catch (err) {
        // if we are dying here, this is likely some an authenticator blowing up
        this.close(err as Error).catch();
      }
    }
    if (updates) {
      const { added, deleted } = updates;

      this.dispatchStatus({ type: "update", added, deleted });
    }
    const ldm = info.ldm !== undefined ? info.ldm : false;
    if (ldm) {
      this.dispatchStatus(
        {
          type: "ldm",
          server: this.servers.getCurrentServer().toString(),
        },
      );
    }
  }

  push(e: ParserEvent): void {
    switch (e.kind) {
      case Kind.MSG: {
        const { msg, data } = e;
        this.processMsg(msg!, data!);
        break;
      }
      case Kind.OK:
        break;
      case Kind.ERR:
        this.processError(e.data!);
        break;
      case Kind.PING:
        this.processPing();
        break;
      case Kind.PONG:
        this.processPong();
        break;
      case Kind.INFO:
        this.processInfo(e.data!);
        break;
    }
  }

  sendCommand(cmd: string | Uint8Array, ...payloads: Uint8Array[]) {
    const len = this.outbound.length();
    let buf: Uint8Array;
    if (typeof cmd === "string") {
      buf = encode(cmd);
    } else {
      buf = cmd as Uint8Array;
    }
    this.outbound.fill(buf, ...payloads);

    if (len === 0) {
      queueMicrotask(() => {
        this.flushPending();
      });
    } else if (this.outbound.size() >= this.pendingLimit) {
      // flush inline
      this.flushPending();
    }
  }

  publish(
    subject: string,
    payload: Payload = Empty,
    options?: PublishOptions,
  ): void {
    let data;
    if (payload instanceof Uint8Array) {
      data = payload;
    } else if (typeof payload === "string") {
      data = TE.encode(payload);
    } else {
      throw new TypeError(
        "payload types can be strings or Uint8Array",
      );
    }

    let len = data.length;
    options = options || {};
    options.reply = options.reply || "";

    let headers = Empty;
    let hlen = 0;
    if (options.headers) {
      if (this.info && !this.info.headers) {
        InvalidArgumentError.format(
          "headers",
          "are not available on this server",
        );
      }
      const hdrs = options.headers as MsgHdrsImpl;
      headers = hdrs.encode();
      hlen = headers.length;
      len = data.length + hlen;
    }

    if (this.info && len > this.info.max_payload) {
      throw InvalidArgumentError.format("payload", "max_payload size exceeded");
    }
    this.outBytes += len;
    this.outMsgs++;

    let proto: string;
    if (options.headers) {
      if (options.reply) {
        proto = `HPUB ${subject} ${options.reply} ${hlen} ${len}\r\n`;
      } else {
        proto = `HPUB ${subject} ${hlen} ${len}\r\n`;
      }
      this.sendCommand(proto, headers, data, CRLF);
    } else {
      if (options.reply) {
        proto = `PUB ${subject} ${options.reply} ${len}\r\n`;
      } else {
        proto = `PUB ${subject} ${len}\r\n`;
      }
      this.sendCommand(proto, data, CRLF);
    }
  }

  request(r: Request): Request {
    this.initMux();
    this.muxSubscriptions.add(r);
    return r;
  }

  subscribe(s: SubscriptionImpl): Subscription {
    this.subscriptions.add(s);
    this._subunsub(s);
    return s;
  }

  _sub(s: SubscriptionImpl): void {
    if (s.queue) {
      this.sendCommand(`SUB ${s.subject} ${s.queue} ${s.sid}\r\n`);
    } else {
      this.sendCommand(`SUB ${s.subject} ${s.sid}\r\n`);
    }
  }

  _subunsub(s: SubscriptionImpl): SubscriptionImpl {
    this._sub(s);
    if (s.max) {
      this.unsubscribe(s, s.max);
    }
    return s;
  }

  unsubscribe(s: SubscriptionImpl, max?: number): void {
    this.unsub(s, max);
    if (s.max === undefined || s.received >= s.max) {
      this.subscriptions.cancel(s);
    }
  }

  unsub(s: SubscriptionImpl, max?: number): void {
    if (!s || this.isClosed()) {
      return;
    }
    if (max) {
      this.sendCommand(`UNSUB ${s.sid} ${max}\r\n`);
    } else {
      this.sendCommand(`UNSUB ${s.sid}\r\n`);
    }
    s.max = max;
  }

  resub(s: SubscriptionImpl, subject: string): void {
    if (!s || this.isClosed()) {
      return;
    }
    this.unsub(s);
    s.subject = subject;
    this.subscriptions.resub(s);
    // we don't auto-unsub here because we don't
    // really know "processed"
    this._sub(s);
  }

  flush(p?: Deferred<void>): Promise<void> {
    if (!p) {
      p = deferred<void>();
    }
    this.pongs.push(p);
    this.outbound.fill(PING_CMD);
    this.flushPending();
    return p;
  }

  sendSubscriptions(): void {
    const cmds: string[] = [];
    this.subscriptions.all().forEach((s) => {
      const sub = s as SubscriptionImpl;
      if (sub.queue) {
        cmds.push(`SUB ${sub.subject} ${sub.queue} ${sub.sid}${CR_LF}`);
      } else {
        cmds.push(`SUB ${sub.subject} ${sub.sid}${CR_LF}`);
      }
    });
    if (cmds.length) {
      this.transport.send(encode(cmds.join("")));
    }
  }

  async close(err?: Error): Promise<void> {
    if (this._closed) {
      return;
    }
    this.whyClosed = new Error("close trace").stack || "";
    this.heartbeats.cancel();
    if (this.connectError) {
      this.connectError(err);
      this.connectError = undefined;
    }
    this.muxSubscriptions.close();
    this.subscriptions.close();
    const proms = [];
    for (let i = 0; i < this.listeners.length; i++) {
      const qi = this.listeners[i];
      if (qi) {
        qi.push({ type: "close" });
        qi.stop();
        proms.push(qi.iterClosed);
      }
    }
    if (proms.length) {
      await Promise.all(proms);
    }
    this._closed = true;
    await this.transport.close(err);
    this.raceTimer?.cancel();
    this.dialDelay?.cancel();
    this.closed.resolve(err);
  }

  isClosed(): boolean {
    return this._closed;
  }

  async drain(): Promise<void> {
    const subs = this.subscriptions.all();
    const promises: Promise<void>[] = [];
    subs.forEach((sub: Subscription) => {
      promises.push(sub.drain());
    });
    try {
      await Promise.allSettled(promises);
    } catch {
      // nothing we can do here
    } finally {
      this.noMorePublishing = true;
      await this.flush();
    }
    return this.close();
  }

  private flushPending() {
    if (!this.infoReceived || !this.connected) {
      return;
    }

    if (this.outbound.size()) {
      const d = this.outbound.drain();
      this.transport.send(d);
    }
  }

  private initMux(): void {
    const mux = this.subscriptions.getMux();
    if (!mux) {
      const inbox = this.muxSubscriptions.init(
        this.options.inboxPrefix,
      );
      // dot is already part of mux
      const sub = new SubscriptionImpl(this, `${inbox}*`);
      sub.callback = this.muxSubscriptions.dispatcher();
      this.subscriptions.setMux(sub);
      this.subscribe(sub);
    }
  }

  private selectServer(): ServerImpl | undefined {
    const server = this.servers.selectServer();
    if (server === undefined) {
      return undefined;
    }
    // Place in client context.
    this.server = server;
    return this.server;
  }

  getServer(): ServerImpl | undefined {
    return this.server;
  }
}
