/*
 * Copyright 2025 The NATS Authors
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

export function parseSha256(s: string): Uint8Array | null {
  return toByteArray(s);
}

function isHex(s: string): boolean {
  // contains valid hex characters only
  const hexRegex = /^[0-9A-Fa-f]+$/;
  if (!hexRegex.test(s)) {
    // non-hex characters
    return false;
  }

  // check for mixed-case strings - paranoid base64 sneaked in
  const isAllUpperCase = /^[0-9A-F]+$/.test(s);
  const isAllLowerCase = /^[0-9a-f]+$/.test(s);
  if (!(isAllUpperCase || isAllLowerCase)) {
    return false;
  }

  // ensure the input string length is even
  return s.length % 2 === 0;
}

function isBase64(s: string): boolean {
  // test for padded or normal base64
  return /^[A-Za-z0-9\-_]*(={0,2})?$/.test(s) ||
    /^[A-Za-z0-9+/]*(={0,2})?$/.test(s);
}

function detectEncoding(input: string): "hex" | "b64" | "" {
  // hex is more reliable to flush out...
  if (isHex(input)) {
    return "hex";
  } else if (isBase64(input)) {
    return "b64";
  }
  return "";
}

function hexToByteArray(s: string): Uint8Array {
  if (s.length % 2 !== 0) {
    throw new Error("hex string must have an even length");
  }
  const a = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    // parse hex two chars at a time
    a[i / 2] = parseInt(s.substring(i, i + 2), 16);
  }
  return a;
}

function base64ToByteArray(s: string): Uint8Array {
  // could be url friendly
  s = s.replace(/-/g, "+");
  s = s.replace(/_/g, "/");
  const sbin = atob(s);
  return Uint8Array.from(sbin, (c) => c.charCodeAt(0));
}

function toByteArray(input: string): Uint8Array | null {
  const encoding = detectEncoding(input);
  switch (encoding) {
    case "hex":
      return hexToByteArray(input);
    case "b64":
      return base64ToByteArray(input);
  }
  return null;
}

export function checkSha256(
  a: string | Uint8Array,
  b: string | Uint8Array,
): boolean {
  const aBytes = typeof a === "string" ? parseSha256(a) : a;
  const bBytes = typeof b === "string" ? parseSha256(b) : b;
  if (aBytes === null || bBytes === null) {
    return false;
  }
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  for (let i = 0; i < aBytes.length; i++) {
    if (aBytes[i] !== bBytes[i]) {
      return false;
    }
  }
  return true;
}
