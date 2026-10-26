/*
 * Copyright 2026 The NATS Authors
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
const { describe, it } = require("node:test");
const assert = require("node:assert").strict;
const { connect, createInbox } = require("../lib/mod");

const render = (f) => new TextDecoder().decode(f);
const { NatsServer } = require("@nats-io/nst");

// runs fn with console.info/console.error captured
async function captureConsole(fn) {
  const { info, error } = console;
  const out = { info: [], error: [] };
  console.info = (...args) => out.info.push(args.join(" "));
  console.error = (...args) => out.error.push(args);
  try {
    await fn();
  } finally {
    console.info = info;
    console.error = error;
  }
  return out;
}

// a request to an echo service makes frames in both directions
async function roundTrip(nc) {
  const subj = createInbox();
  nc.subscribe(subj, {
    callback: (_, m) => {
      m.respond(m.data);
    },
  });
  const r = await nc.request(subj, "hello");
  assert.equal(r.string(), "hello");
}

describe("debug", { timeout: 20_000, forceExit: true }, () => {
  it("true prints frames", async () => {
    const ns = await NatsServer.start();
    const { info } = await captureConsole(async () => {
      const nc = await connect({ port: ns.port, debug: true });
      await roundTrip(nc);
      await nc.close();
    });
    await ns.stop();
    assert.ok(info.some((l) => l.startsWith("> INFO ")));
    assert.ok(info.some((l) => l.startsWith("< CONNECT ")));
    assert.ok(info.every((l) => l.startsWith("> ") || l.startsWith("< ")));
  });

  it("function gets frames both ways", async () => {
    const ns = await NatsServer.start();
    const frames = [];
    const { info } = await captureConsole(async () => {
      const nc = await connect({
        port: ns.port,
        debug: (d, f) => frames.push([d, render(f)]),
      });
      await roundTrip(nc);
      await nc.close();
    });
    await ns.stop();
    assert.deepEqual(info, []);
    assert.ok(frames.some(([d, f]) => d === ">" && f.startsWith("INFO ")));
    assert.ok(frames.some(([d, f]) => d === "<" && f.startsWith("CONNECT ")));
    assert.ok(frames.some(([d, f]) => d === "<" && f.includes("hello")));
    assert.ok(frames.some(([d, f]) => d === ">" && f.includes("hello")));
  });

  it("function can't change frames", async () => {
    const ns = await NatsServer.start();
    // zero every frame the hook gets - the connection must not notice
    const nc = await connect({ port: ns.port, debug: (_, f) => f.fill(0) });
    await roundTrip(nc);
    await nc.close();
    await ns.stop();
  });

  it("throwing function is turned off", async () => {
    const ns = await NatsServer.start();
    let calls = 0;
    const boom = new Error("boom");
    const debug = () => {
      calls++;
      throw boom;
    };
    const opts = { port: ns.port, debug };
    const { error } = await captureConsole(async () => {
      const nc = await connect(opts);
      await roundTrip(nc);
      await nc.close();
    });
    await ns.stop();
    assert.equal(calls, 1);
    assert.equal(error.length, 1);
    assert.match(error[0][0].message, /debug function threw/);
    assert.equal(error[0][0].cause, boom);
    // the caller's options are untouched
    assert.equal(opts.debug, debug);
  });
});
