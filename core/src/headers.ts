/*
 * Copyright 2020-2023 The NATS Authors
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

// Heavily inspired by Golang's https://golang.org/src/net/http/header.go

import { TD, TE } from "./encoders.ts";
import type { MsgHdrs } from "./core.ts";
import { Match } from "./core.ts";
import { InvalidArgumentError } from "./errors.ts";

// https://www.ietf.org/rfc/rfc822.txt
// 3.1.2.  STRUCTURE OF HEADER FIELDS
//
// Once a field has been unfolded, it may be viewed as being com-
// posed of a field-name followed by a colon (":"), followed by a
// field-body, and  terminated  by  a  carriage-return/line-feed.
// The  field-name must be composed of printable ASCII characters
// (i.e., characters that  have  values  between  33.  and  126.,
// decimal, except colon).  The field-body may be composed of any
// ASCII characters, except CR or LF.  (While CR and/or LF may be
// present  in the actual text, they are removed by the action of
// unfolding the field.)
export function canonicalMIMEHeaderKey(k: string): string {
  const a = 97;
  const A = 65;
  const Z = 90;
  const z = 122;
  const dash = 45;
  const colon = 58;
  const start = 33;
  const end = 126;
  const toLower = a - A;

  let upper = true;
  const buf: number[] = new Array(k.length);
  for (let i = 0; i < k.length; i++) {
    let c = k.charCodeAt(i);
    if (c === colon || c < start || c > end) {
      throw InvalidArgumentError.format(
        "header",
        `'${k[i]}' is not a valid character in a header name`,
      );
    }
    if (upper && a <= c && c <= z) {
      c -= toLower;
    } else if (!upper && A <= c && c <= Z) {
      c += toLower;
    }
    buf[i] = c;
    upper = c == dash;
  }
  return String.fromCharCode(...buf);
}

export function headers(code = 0, description = ""): MsgHdrs {
  if (code === 0 && description !== "") {
    throw InvalidArgumentError.format("code", "is required");
  } else if (code > 0 && description === "") {
    throw InvalidArgumentError.format("description", "is required");
  }
  return new MsgHdrsImpl(code, description);
}

const HEADER = "NATS/1.0";

export class MsgHdrsImpl implements MsgHdrs {
  _code: number;
  headers: Map<string, string[]>;
  _description: string;

  constructor(code = 0, description = "") {
    this._code = code;
    this._description = description;
    this.headers = new Map();
  }

  [Symbol.iterator](): IterableIterator<[string, string[]]> {
    return this.headers.entries();
  }

  size(): number {
    return this.headers.size;
  }

  equals(mh: MsgHdrsImpl): boolean {
    if (
      mh && this.headers.size === mh.headers.size &&
      this._code === mh._code
    ) {
      for (const [k, v] of this.headers) {
        const a = mh.values(k);
        if (v.length !== a.length) {
          return false;
        }
        const vv = [...v].sort();
        const aa = [...a].sort();
        for (let i = 0; i < vv.length; i++) {
          if (vv[i] !== aa[i]) {
            return false;
          }
        }
      }
      return true;
    }
    return false;
  }

  static decode(a: Uint8Array): MsgHdrsImpl {
    const mh = new MsgHdrsImpl();
    const s = TD.decode(a);
    const lines = s.split("\r\n");
    const h = lines[0];
    if (h !== HEADER) {
      // malformed headers could add extra space without adding a code or description
      let str = h.replace(HEADER, "").trim();
      if (str.length > 0) {
        mh._code = parseInt(str, 10);
        if (isNaN(mh._code)) {
          mh._code = 0;
        }
        const scode = mh._code.toString();
        str = str.replace(scode, "");
        mh._description = str.trim();
      }
    }
    if (lines.length >= 1) {
      lines.slice(1).map((s) => {
        if (s) {
          const idx = s.indexOf(":");
          if (idx > -1) {
            const k = s.slice(0, idx);
            const v = s.slice(idx + 1).trim();
            mh.append(k, v);
          }
        }
      });
    }
    return mh;
  }

  toString(): string {
    if (this.headers.size === 0 && this._code === 0) {
      return "";
    }
    let s = HEADER;
    if (this._code > 0 && this._description !== "") {
      s += ` ${this._code} ${this._description}`;
    }
    for (const [k, v] of this.headers) {
      for (let i = 0; i < v.length; i++) {
        s = `${s}\r\n${k}: ${v[i]}`;
      }
    }
    return `${s}\r\n\r\n`;
  }

  encode(): Uint8Array {
    return TE.encode(this.toString());
  }

  static validHeaderValue(k: string): string {
    const inv = /[\r\n]/;
    if (inv.test(k)) {
      throw InvalidArgumentError.format(
        "header",
        "values cannot contain \\r or \\n",
      );
    }
    return k.trim();
  }

  keys(): string[] {
    const keys = [];
    for (const sk of this.headers.keys()) {
      keys.push(sk);
    }
    return keys;
  }

  findKeys(k: string, match: Match = Match.Exact): string[] {
    const keys = this.keys();
    switch (match) {
      case Match.Exact:
        return keys.filter((v) => {
          return v === k;
        });
      case Match.CanonicalMIME:
        k = canonicalMIMEHeaderKey(k);
        return keys.filter((v) => {
          return v === k;
        });
      default: {
        const lci = k.toLowerCase();
        return keys.filter((v) => {
          return lci === v.toLowerCase();
        });
      }
    }
  }

  get(k: string, match = Match.Exact): string {
    const keys = this.findKeys(k, match);
    if (keys.length) {
      const v = this.headers.get(keys[0]);
      if (v) {
        return Array.isArray(v) ? v[0] : v;
      }
    }
    return "";
  }

  last(k: string, match = Match.Exact): string {
    const keys = this.findKeys(k, match);
    if (keys.length) {
      const v = this.headers.get(keys[0]);
      if (v) {
        return Array.isArray(v) ? v[v.length - 1] : v;
      }
    }
    return "";
  }

  has(k: string, match: Match = Match.Exact): boolean {
    return this.findKeys(k, match).length > 0;
  }

  set(k: string, v: string, match: Match = Match.Exact): void {
    this.delete(k, match);
    this.append(k, v, match);
  }

  append(k: string, v: string, match: Match = Match.Exact): void {
    // validate the key
    const ck = canonicalMIMEHeaderKey(k);
    if (match === Match.CanonicalMIME) {
      k = ck;
    }
    // if we get non-sensical ignores/etc, we should try
    // to do the right thing and use the first key that matches
    const keys = this.findKeys(k, match);
    k = keys.length > 0 ? keys[0] : k;

    const value = MsgHdrsImpl.validHeaderValue(v);
    let a = this.headers.get(k);
    if (!a) {
      a = [];
      this.headers.set(k, a);
    }
    a.push(value);
  }

  values(k: string, match: Match = Match.Exact): string[] {
    const buf: string[] = [];
    const keys = this.findKeys(k, match);
    keys.forEach((v) => {
      const values = this.headers.get(v);
      if (values) {
        buf.push(...values);
      }
    });
    return buf;
  }

  delete(k: string, match: Match = Match.Exact): void {
    const keys = this.findKeys(k, match);
    keys.forEach((v) => {
      this.headers.delete(v);
    });
  }

  get hasError(): boolean {
    return this._code >= 300;
  }

  get status(): string {
    return `${this._code} ${this._description}`.trim();
  }

  toRecord(): Record<string, string[]> {
    const data = {} as Record<string, string[]>;
    this.keys().forEach((v) => {
      data[v] = this.values(v);
    });
    return data;
  }

  get code(): number {
    return this._code;
  }

  get description(): string {
    return this._description;
  }

  static fromRecord(r: Record<string, string[]>): MsgHdrs {
    const h = new MsgHdrsImpl();
    for (const k in r) {
      const v = r[k];
      h.headers.set(k, Array.isArray(v) ? v : [`${v}`]);
    }
    return h;
  }
}
