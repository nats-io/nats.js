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

import { InvalidNameError } from "./jserrors.ts";

export function validateDurableName(name?: string) {
  return minValidation("durable", name);
}

export function validateStreamName(name?: string) {
  return minValidation("stream", name);
}

export function minValidation(context: string, name = "") {
  // minimum validation on streams/consumers matches nats cli
  if (name === "") {
    throw Error(`${context} name required`);
  }
  const bad = [".", "*", ">", "/", "\\", " ", "\t", "\n", "\r"];
  bad.forEach((v) => {
    if (name.indexOf(v) !== -1) {
      // make the error have a meaningful character
      switch (v) {
        case "\n":
          v = "\\n";
          break;
        case "\r":
          v = "\\r";
          break;
        case "\t":
          v = "\\t";
          break;
        default:
          // nothing
      }
      throw new InvalidNameError(
        `${context} name ('${name}') cannot contain '${v}'`,
      );
    }
  });
  return "";
}

export function validateName(context: string, name = "") {
  if (name === "") {
    throw Error(`${context} name required`);
  }
  const m = validName(name);
  if (m.length) {
    throw new Error(`invalid ${context} name - ${context} name ${m}`);
  }
}

export function validName(name = ""): string {
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
