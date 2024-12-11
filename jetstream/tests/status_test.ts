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

import { isMessageNotFound, JetStreamStatus } from "../src/jserrors.ts";
import type { StreamAPIImpl } from "../src/jsmstream_api.ts";
import { Empty, type Msg, type Payload } from "@nats-io/nats-core/internal";
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.221.0/assert/mod.ts";
import { MsgHdrsImpl } from "../../core/src/headers.ts";
import { cleanup, setup } from "test_helpers";
import { jetstreamServerConf } from "../../test_helpers/mod.ts";
import {
  type JetStreamApiError,
  jetstreamManager,
} from "../src/internal_mod.ts";

Deno.test("js status - basics", async (t) => {
  function makeMsg(
    code: number,
    description: string,
    payload: Payload = Empty,
    hdrs: [string, string[]][] = [],
  ): Msg {
    const h = new MsgHdrsImpl(code, description);
    for (const [k, v] of hdrs) {
      for (const e of v) {
        h.append(k, e);
      }
    }
    let data: Uint8Array = Empty;
    if (typeof payload === "string") {
      data = new TextEncoder().encode(payload);
    } else {
      data = payload;
    }

    return {
      subject: "foo",
      reply: "",
      headers: h,
      data,
      sid: 1,
      respond: function () {
        return this.reply !== "";
      },
      string: function () {
        return new TextDecoder().decode(this.data);
      },
      json: function () {
        return JSON.parse(this.string());
      },
    };
  }

  function makeStatus(
    code: number,
    description: string,
    payload: Payload = Empty,
    hdrs?: [string, string[]][],
  ): JetStreamStatus {
    return new JetStreamStatus(makeMsg(code, description, payload, hdrs));
  }

  await t.step("debug", () => {
    const s = makeStatus(404, "not found");
    s.debug();
  });

  await t.step("empty description", () => {
    const s = makeStatus(404, "");
    assertEquals(s.description, "unknown");
  });

  await t.step("idle heartbeat", () => {
    const s = makeStatus(100, "idle heartbeat", Empty, [["Nats-Last-Consumer", [
      "1",
    ]], ["Nats-Last-Stream", ["10"]]]);
    assert(s.isIdleHeartbeat());
    assertEquals(s.parseHeartbeat(), {
      type: "heartbeat",
      lastConsumerSequence: 1,
      lastStreamSequence: 10,
    });

    assertEquals(s.description, "idle heartbeat");
  });

  await t.step("idle heartbeats missed", () => {
    const s = makeStatus(409, "idle heartbeats missed");
    assert(s.isIdleHeartbeatMissed());
  });

  await t.step("request timeout", () => {
    const s = makeStatus(408, "request timeout");
    assert(s.isRequestTimeout());
  });

  await t.step("bad request", () => {
    const s = makeStatus(400, "");
    assert(s.isBadRequest());
  });

  await t.step("stream deleted", () => {
    const s = makeStatus(409, "stream deleted");
    assert(s.isStreamDeleted());
  });

  await t.step("exceeded maxwaiting", () => {
    const s = makeStatus(409, "exceeded maxwaiting");
    assert(s.isMaxWaitingExceeded());
  });

  await t.step("consumer is push based", () => {
    const s = makeStatus(409, "consumer is push based");
    assert(s.isConsumerIsPushBased());
  });
});

Deno.test("api error - basics", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await jetstreamManager(nc);
  await jsm.streams.add({
    name: "test",
    subjects: ["foo"],
    allow_direct: true,
  });

  const api = jsm.streams as StreamAPIImpl;
  const err = await assertRejects(() => {
    return api._request(`$JS.API.STREAM.MSG.GET.test`, { seq: 1 });
  });
  const apiErr = err as JetStreamApiError;
  assert(isMessageNotFound(err as Error));
  const data = apiErr.apiError();
  assertEquals(data.code, 404);
  assertEquals(data.err_code, 10037);
  assertEquals(data.description, "no message found");

  await cleanup(ns, nc);
});
