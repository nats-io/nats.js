/*
 * Copyright 2022-2023 The NATS Authors
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
  deferred,
  Empty,
  headers,
  nanos,
  nuid,
  parseSemVer,
  QueuedIteratorImpl,
} from "@nats-io/nats-core/internal";
import type {
  Deferred,
  Msg,
  MsgHdrs,
  Nanos,
  NatsConnection,
  NatsError,
  Payload,
  PublishOptions,
  QueuedIterator,
  ReviverFn,
  Sub,
} from "@nats-io/nats-core/internal";

import {
  ServiceError,
  ServiceErrorCodeHeader,
  ServiceErrorHeader,
  ServiceResponseType,
  ServiceVerb,
} from "./types.ts";

import type {
  Endpoint,
  EndpointInfo,
  EndpointOptions,
  NamedEndpointStats,
  Service,
  ServiceConfig,
  ServiceGroup,
  ServiceHandler,
  ServiceIdentity,
  ServiceInfo,
  ServiceMsg,
  ServiceStats,
} from "./types.ts";

function validateName(context: string, name = "") {
  if (name === "") {
    throw Error(`${context} name required`);
  }
  const m = validName(name);
  if (m.length) {
    throw new Error(`invalid ${context} name - ${context} name ${m}`);
  }
}

function validName(name = ""): string {
  if (name === "") {
    throw Error(`name required`);
  }
  const RE = /^[-\w]+$/g;
  const m = name.match(RE);
  if (m === null) {
    for (const c of name.split("")) {
      const mm = c.match(RE);
      if (mm === null) {
        return `cannot contain '${c}'`;
      }
    }
  }
  return "";
}

/**
 * Services have common backplane subject pattern:
 *
 * `$SRV.PING|STATS|INFO` - pings or retrieves status for all services
 * `$SRV.PING|STATS|INFO.<name>` - pings or retrieves status for all services having the specified name
 * `$SRV.PING|STATS|INFO.<name>.<id>` - pings or retrieves status of a particular service
 *
 * Note that <name> and <id> are upper-cased.
 */
export const ServiceApiPrefix = "$SRV";

export class ServiceMsgImpl implements ServiceMsg {
  msg: Msg;
  constructor(msg: Msg) {
    this.msg = msg;
  }

  get data(): Uint8Array {
    return this.msg.data;
  }

  get sid(): number {
    return this.msg.sid;
  }

  get subject(): string {
    return this.msg.subject;
  }

  get reply(): string {
    return this.msg.reply || "";
  }

  get headers(): MsgHdrs | undefined {
    return this.msg.headers;
  }

  respond(data?: Payload, opts?: PublishOptions): boolean {
    return this.msg.respond(data, opts);
  }

  respondError(
    code: number,
    description: string,
    data?: Payload,
    opts?: PublishOptions,
  ): boolean {
    opts = opts || {};
    opts.headers = opts.headers || headers();
    opts.headers?.set(ServiceErrorCodeHeader, `${code}`);
    opts.headers?.set(ServiceErrorHeader, description);
    return this.msg.respond(data, opts);
  }

  json<T = unknown>(reviver?: ReviverFn): T {
    return this.msg.json(reviver);
  }

  string(): string {
    return this.msg.string();
  }
}

export class ServiceGroupImpl implements ServiceGroup {
  subject: string;
  queue: string;
  srv: ServiceImpl;
  constructor(parent: ServiceGroup, name = "", queue = "") {
    if (name !== "") {
      validInternalToken("service group", name);
    }
    let root = "";
    if (parent instanceof ServiceImpl) {
      this.srv = parent as ServiceImpl;
      root = "";
    } else if (parent instanceof ServiceGroupImpl) {
      const sg = parent as ServiceGroupImpl;
      this.srv = sg.srv;
      if (queue === "" && sg.queue !== "") {
        queue = sg.queue;
      }
      root = sg.subject;
    } else {
      throw new Error("unknown ServiceGroup type");
    }
    this.subject = this.calcSubject(root, name);
    this.queue = queue;
  }

  calcSubject(root: string, name = ""): string {
    if (name === "") {
      return root;
    }
    return root !== "" ? `${root}.${name}` : name;
  }
  addEndpoint(
    name = "",
    opts?: ServiceHandler | EndpointOptions,
  ): QueuedIterator<ServiceMsg> {
    opts = opts || { subject: name } as EndpointOptions;
    const args: EndpointOptions = typeof opts === "function"
      ? { handler: opts, subject: name }
      : opts;
    validateName("endpoint", name);
    let { subject, handler, metadata, queue } = args;
    subject = subject || name;
    queue = queue || this.queue;
    validSubjectName("endpoint subject", subject);
    subject = this.calcSubject(this.subject, subject);

    const ne = { name, subject, queue, handler, metadata };
    return this.srv._addEndpoint(ne);
  }

  addGroup(name = "", queue = ""): ServiceGroup {
    return new ServiceGroupImpl(this, name, queue);
  }
}

function validSubjectName(context: string, subj: string) {
  if (subj === "") {
    throw new Error(`${context} cannot be empty`);
  }
  if (subj.indexOf(" ") !== -1) {
    throw new Error(`${context} cannot contain spaces: '${subj}'`);
  }
  const tokens = subj.split(".");
  tokens.forEach((v, idx) => {
    if (v === ">" && idx !== tokens.length - 1) {
      throw new Error(`${context} cannot have internal '>': '${subj}'`);
    }
  });
}

function validInternalToken(context: string, subj: string) {
  if (subj.indexOf(" ") !== -1) {
    throw new Error(`${context} cannot contain spaces: '${subj}'`);
  }
  const tokens = subj.split(".");
  tokens.forEach((v) => {
    if (v === ">") {
      throw new Error(`${context} name cannot contain internal '>': '${subj}'`);
    }
  });
}

type NamedEndpoint = {
  name: string;
} & Endpoint;

type ServiceSubscription<T = unknown> =
  & NamedEndpoint
  & {
    internal: boolean;
    sub: Sub<T>;
    qi?: QueuedIterator<T>;
    stats: NamedEndpointStatsImpl;
    metadata?: Record<string, string>;
  };

export class ServiceImpl implements Service {
  nc: NatsConnection;
  _id: string;
  config: ServiceConfig;
  handlers: ServiceSubscription[];
  internal: ServiceSubscription[];
  _stopped: boolean;
  _done: Deferred<Error | null>;
  started: string;

  /**
   * @param verb
   * @param name
   * @param id
   * @param prefix - this is only supplied by tooling when building control subject that crosses an account
   */
  static controlSubject(
    verb: ServiceVerb,
    name = "",
    id = "",
    prefix?: string,
  ) {
    // the prefix is used as is, because it is an
    // account boundary permission
    const pre = prefix ?? ServiceApiPrefix;
    if (name === "" && id === "") {
      return `${pre}.${verb}`;
    }
    validateName("control subject name", name);
    if (id !== "") {
      validateName("control subject id", id);
      return `${pre}.${verb}.${name}.${id}`;
    }
    return `${pre}.${verb}.${name}`;
  }

  constructor(
    nc: NatsConnection,
    config: ServiceConfig = { name: "", version: "" },
  ) {
    this.nc = nc;
    this.config = Object.assign({}, config);
    if (!this.config.queue) {
      this.config.queue = "q";
    }

    // this will throw if no name
    validateName("name", this.config.name);
    validateName("queue", this.config.queue);

    // this will throw if not semver
    parseSemVer(this.config.version);
    this._id = nuid.next();
    this.internal = [] as ServiceSubscription[];
    this._done = deferred();
    this._stopped = false;
    this.handlers = [];
    this.started = new Date().toISOString();
    // initialize the stats
    this.reset();

    // close if the connection closes
    this.nc.closed()
      .then(() => {
        this.close().catch();
      })
      .catch((err) => {
        this.close(err).catch();
      });
  }

  get subjects(): string[] {
    return this.handlers.filter((s) => {
      return s.internal === false;
    }).map((s) => {
      return s.subject;
    });
  }

  get id(): string {
    return this._id;
  }

  get name(): string {
    return this.config.name;
  }

  get description(): string {
    return this.config.description ?? "";
  }

  get version(): string {
    return this.config.version;
  }

  get metadata(): Record<string, string> | undefined {
    return this.config.metadata;
  }

  errorToHeader(err: Error): MsgHdrs {
    const h = headers();
    if (err instanceof ServiceError) {
      const se = err as ServiceError;
      h.set(ServiceErrorHeader, se.message);
      h.set(ServiceErrorCodeHeader, `${se.code}`);
    } else {
      h.set(ServiceErrorHeader, err.message);
      h.set(ServiceErrorCodeHeader, "500");
    }
    return h;
  }

  setupHandler(
    h: NamedEndpoint,
    internal = false,
  ): ServiceSubscription {
    // internals don't use a queue
    const queue = internal ? "" : (h.queue ? h.queue : this.config.queue);
    const { name, subject, handler } = h as NamedEndpoint;
    const sv = h as ServiceSubscription;
    sv.internal = internal;
    if (internal) {
      this.internal.push(sv);
    }
    sv.stats = new NamedEndpointStatsImpl(name, subject, queue);
    sv.queue = queue;

    const callback = handler
      ? (err: NatsError | null, msg: Msg) => {
        if (err) {
          this.close(err);
          return;
        }
        const start = Date.now();
        try {
          handler(err, new ServiceMsgImpl(msg));
        } catch (err) {
          sv.stats.countError(err as Error);
          msg?.respond(Empty, { headers: this.errorToHeader(err as Error) });
        } finally {
          sv.stats.countLatency(start);
        }
      }
      : undefined;

    sv.sub = this.nc.subscribe(subject, {
      callback,
      queue,
    });

    sv.sub.closed
      .then(() => {
        if (!this._stopped) {
          this.close(new Error(`required subscription ${h.subject} stopped`))
            .catch();
        }
      })
      .catch((err) => {
        if (!this._stopped) {
          const ne = new Error(
            `required subscription ${h.subject} errored: ${err.message}`,
          );
          ne.stack = err.stack;
          this.close(ne).catch();
        }
      });
    return sv;
  }

  info(): ServiceInfo {
    return {
      type: ServiceResponseType.INFO,
      name: this.name,
      id: this.id,
      version: this.version,
      description: this.description,
      metadata: this.metadata,
      endpoints: this.endpoints(),
    } as ServiceInfo;
  }

  endpoints(): EndpointInfo[] {
    return this.handlers.map((v) => {
      const { subject, metadata, name, queue } = v;
      return { subject, metadata, name, queue_group: queue };
    });
  }

  async stats(): Promise<ServiceStats> {
    const endpoints: NamedEndpointStats[] = [];
    for (const h of this.handlers) {
      if (typeof this.config.statsHandler === "function") {
        try {
          h.stats.data = await this.config.statsHandler(h);
        } catch (err) {
          h.stats.countError(err as Error);
        }
      }
      endpoints.push(h.stats.stats(h.qi));
    }
    return {
      type: ServiceResponseType.STATS,
      name: this.name,
      id: this.id,
      version: this.version,
      started: this.started,
      metadata: this.metadata,
      endpoints,
    };
  }

  addInternalHandler(
    verb: ServiceVerb,
    handler: (err: NatsError | null, msg: Msg) => Promise<void>,
  ) {
    const v = `${verb}`.toUpperCase();
    this._doAddInternalHandler(`${v}-all`, verb, handler);
    this._doAddInternalHandler(`${v}-kind`, verb, handler, this.name);
    this._doAddInternalHandler(
      `${v}`,
      verb,
      handler,
      this.name,
      this.id,
    );
  }

  _doAddInternalHandler(
    name: string,
    verb: ServiceVerb,
    handler: (err: NatsError | null, msg: Msg) => Promise<void>,
    kind = "",
    id = "",
  ) {
    const endpoint = {} as NamedEndpoint;
    endpoint.name = name;
    endpoint.subject = ServiceImpl.controlSubject(verb, kind, id);
    endpoint.handler = handler;
    this.setupHandler(endpoint, true);
  }

  start(): Promise<Service> {
    const statsHandler = (err: Error | null, msg: Msg): Promise<void> => {
      if (err) {
        this.close(err);
        return Promise.reject(err);
      }
      return this.stats().then((s) => {
        msg?.respond(JSON.stringify(s));
        return Promise.resolve();
      });
    };

    const infoHandler = (err: Error | null, msg: Msg): Promise<void> => {
      if (err) {
        this.close(err);
        return Promise.reject(err);
      }
      msg?.respond(JSON.stringify(this.info()));
      return Promise.resolve();
    };

    const ping = JSON.stringify(this.ping());
    const pingHandler = (err: Error | null, msg: Msg): Promise<void> => {
      if (err) {
        this.close(err).then().catch();
        return Promise.reject(err);
      }
      msg.respond(ping);
      return Promise.resolve();
    };

    this.addInternalHandler(ServiceVerb.PING, pingHandler);
    this.addInternalHandler(ServiceVerb.STATS, statsHandler);
    this.addInternalHandler(ServiceVerb.INFO, infoHandler);

    // now the actual service
    this.handlers.forEach((h) => {
      const { subject } = h as Endpoint;
      if (typeof subject !== "string") {
        return;
      }
      // this is expected in cases where main subject is just
      // a root subject for multiple endpoints - user can disable
      // listening to the root endpoint, by specifying null
      if (h.handler === null) {
        return;
      }
      this.setupHandler(h as unknown as NamedEndpoint);
    });

    return Promise.resolve(this);
  }

  close(err?: Error): Promise<null | Error> {
    if (this._stopped) {
      return this._done;
    }
    this._stopped = true;
    let buf: Promise<void>[] = [];
    if (!this.nc.isClosed()) {
      buf = this.handlers.concat(this.internal).map((h) => {
        return h.sub.drain();
      });
    }
    Promise.allSettled(buf)
      .then(() => {
        this._done.resolve(err ? err : null);
      });
    return this._done;
  }

  get stopped(): Promise<null | Error> {
    return this._done;
  }

  get isStopped(): boolean {
    return this._stopped;
  }

  stop(err?: Error): Promise<null | Error> {
    return this.close(err);
  }

  ping(): ServiceIdentity {
    return {
      type: ServiceResponseType.PING,
      name: this.name,
      id: this.id,
      version: this.version,
      metadata: this.metadata,
    };
  }

  reset(): void {
    // pretend we restarted
    this.started = new Date().toISOString();
    if (this.handlers) {
      for (const h of this.handlers) {
        h.stats.reset(h.qi);
      }
    }
  }

  addGroup(name: string, queue?: string): ServiceGroup {
    return new ServiceGroupImpl(this, name, queue);
  }

  addEndpoint(
    name: string,
    handler?: ServiceHandler | EndpointOptions,
  ): QueuedIterator<ServiceMsg> {
    const sg = new ServiceGroupImpl(this);
    return sg.addEndpoint(name, handler);
  }

  _addEndpoint(
    e: NamedEndpoint,
  ): QueuedIterator<ServiceMsg> {
    const qi = new QueuedIteratorImpl<ServiceMsg>();
    qi.profile = true;
    qi.noIterator = typeof e.handler === "function";
    if (!qi.noIterator) {
      e.handler = (err, msg): void => {
        err ? this.stop(err).catch() : qi.push(new ServiceMsgImpl(msg));
      };
      // close the service if the iterator closes
      qi.iterClosed.then(() => {
        this.close().catch();
      });
    }
    // track the iterator for stats
    const ss = this.setupHandler(e, false);
    ss.qi = qi;
    this.handlers.push(ss);
    return qi;
  }
}

class NamedEndpointStatsImpl implements NamedEndpointStats {
  name: string;
  subject: string;
  average_processing_time: Nanos;
  num_requests: number;
  processing_time: Nanos;
  num_errors: number;
  last_error?: string;
  data?: unknown;
  metadata?: Record<string, string>;
  queue: string;

  constructor(name: string, subject: string, queue = "") {
    this.name = name;
    this.subject = subject;
    this.average_processing_time = 0;
    this.num_errors = 0;
    this.num_requests = 0;
    this.processing_time = 0;
    this.queue = queue;
  }
  reset(qi?: QueuedIterator<unknown>) {
    this.num_requests = 0;
    this.processing_time = 0;
    this.average_processing_time = 0;
    this.num_errors = 0;
    this.last_error = undefined;
    this.data = undefined;
    const qii = qi as QueuedIteratorImpl<unknown>;
    if (qii) {
      qii.time = 0;
      qii.processed = 0;
    }
  }
  countLatency(start: number) {
    this.num_requests++;
    this.processing_time += nanos(Date.now() - start);
    this.average_processing_time = Math.round(
      this.processing_time / this.num_requests,
    );
  }
  countError(err: Error): void {
    this.num_errors++;
    this.last_error = err.message;
  }

  _stats(): NamedEndpointStats {
    const {
      name,
      subject,
      average_processing_time,
      num_errors,
      num_requests,
      processing_time,
      last_error,
      data,
      queue,
    } = this;
    return {
      name,
      subject,
      average_processing_time,
      num_errors,
      num_requests,
      processing_time,
      last_error,
      data,
      queue_group: queue,
    };
  }

  stats(qi?: QueuedIterator<unknown>): NamedEndpointStats {
    const qii = qi as QueuedIteratorImpl<unknown>;
    if (qii?.noIterator === false) {
      // grab stats in the iterator
      this.processing_time = nanos(qii.time);
      this.num_requests = qii.processed;
      this.average_processing_time =
        this.processing_time > 0 && this.num_requests > 0
          ? this.processing_time / this.num_requests
          : 0;
    }
    return this._stats();
  }
}
