/*
 * Copyright 2023 The NATS Authors
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

import { connect } from "jsr:@nats-io/transport-deno";
import { Svcm } from "../src/mod.ts";
import { humanizeBytes } from "./03_util.ts";
import type { DataRequest } from "./03_util.ts";

const nc = await connect({ servers: "demo.nats.io" });
const svc = new Svcm(nc);
const srv = await svc.add({
  name: "big-data",
  version: "0.0.1",
});

srv.addEndpoint("data", (_err, msg) => {
  queueMicrotask(() => {
    if (msg.data.length === 0) {
      msg.respondError(400, "missing request options");
      return;
    }
    const max = nc.info?.max_payload ?? 1024 * 1024;

    const r = msg.json<DataRequest>();

    const size = r.size || max;
    let chunk = r.max_chunk || max;
    chunk = chunk > size ? size : chunk;

    const full = Math.floor(size / chunk);
    const partial = size % chunk;

    console.log(
      "size of request",
      humanizeBytes(size),
      "chunk",
      humanizeBytes(chunk),
    );
    console.log(
      "full buffers:",
      full,
      "partial:",
      partial,
      "bytes",
      "empty:",
      1,
    );

    const payload = new Uint8Array(chunk);
    for (let i = 0; i < full; i++) {
      msg.respond(payload);
    }
    if (partial) {
      msg.respond(payload.subarray(0, partial));
    }
    // sentinel
    msg.respond();
  });
});

console.log(srv.info());
