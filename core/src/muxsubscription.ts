/*
 * Copyright 2020-2021 The NATS Authors
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
import type { Msg, MsgCallback, Request } from "./core.ts";
import { createInbox } from "./core.ts";
import { NoRespondersError, RequestError } from "./errors.ts";

import type { PermissionViolationError } from "./errors.ts";

export class MuxSubscription {
  baseInbox!: string;
  reqs: Map<string, Request>;

  constructor() {
    this.reqs = new Map<string, Request>();
  }

  size(): number {
    return this.reqs.size;
  }

  init(prefix?: string): string {
    this.baseInbox = `${createInbox(prefix)}.`;
    return this.baseInbox;
  }

  add(r: Request) {
    if (!isNaN(r.received)) {
      r.received = 0;
    }
    this.reqs.set(r.token, r);
  }

  get(token: string): Request | undefined {
    return this.reqs.get(token);
  }

  cancel(r: Request): void {
    this.reqs.delete(r.token);
  }

  getToken(m: Msg): string | null {
    const s = m.subject || "";
    if (s.indexOf(this.baseInbox) === 0) {
      return s.substring(this.baseInbox.length);
    }
    return null;
  }

  all(): Request[] {
    return Array.from(this.reqs.values());
  }

  handleError(
    isMuxPermissionError: boolean,
    err: PermissionViolationError,
  ): boolean {
    if (isMuxPermissionError) {
      // one or more requests queued but mux cannot process them
      this.all().forEach((r) => {
        r.resolver(err, {} as Msg);
      });
      return true;
    }
    if (err.operation === "publish") {
      const req = this.all().find((s) => {
        return s.requestSubject === err.subject;
      });
      if (req) {
        req.resolver(err, {} as Msg);
        return true;
      }
    }
    return false;
  }

  dispatcher(): MsgCallback<Msg> {
    return (err: Error | null, m: Msg) => {
      const token = this.getToken(m);
      if (token) {
        const r = this.get(token);
        if (r) {
          if (err === null) {
            err = (m?.data?.length === 0 && m.headers?.code === 503)
              ? new NoRespondersError(r.requestSubject)
              : null;
          }
          r.resolver(err, m);
        }
      }
    };
  }

  close() {
    const err = new RequestError("connection closed");
    this.reqs.forEach((req) => {
      req.resolver(err, {} as Msg);
    });
  }
}
