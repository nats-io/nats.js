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

import {
  DenoBuffer,
  Empty,
  headers,
  Kind,
  MsgHdrsImpl,
  MsgImpl,
  Parser,
  State,
} from "../src/internal_mod.ts";
import type {
  Dispatcher,
  Msg,
  ParserEvent,
  Publisher,
} from "../src/internal_mod.ts";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert";

const te = new TextEncoder();
const td = new TextDecoder();

class NoopDispatcher implements Dispatcher<ParserEvent> {
  push(_a: ParserEvent): void {}
}

export class TestDispatcher implements Dispatcher<ParserEvent> {
  count = 0;
  pings = 0;
  pongs = 0;
  ok = 0;
  errs: ParserEvent[] = [];
  infos: ParserEvent[] = [];
  msgs: ParserEvent[] = [];

  push(a: ParserEvent): void {
    this.count++;
    switch (a.kind) {
      case Kind.OK:
        this.ok++;
        break;
      case Kind.ERR:
        this.errs.push(a);
        break;
      case Kind.MSG:
        this.msgs.push(a);
        break;
      case Kind.INFO:
        this.infos.push(a);
        break;
      case Kind.PING:
        this.pings++;
        break;
      case Kind.PONG:
        this.pongs++;
        break;
      default:
        throw new Error(`unknown parser event ${JSON.stringify(a)}`);
    }
  }
}

// These are almost verbatim ports of the NATS parser tests

function byByteTest(
  data: Uint8Array,
): { states: State[]; dispatcher: TestDispatcher } {
  const e = new TestDispatcher();
  const p = new Parser(e);
  const states: State[] = [];
  assertEquals(p.state, State.OP_START);

  for (let i = 0; i < data.length; i++) {
    states.push(p.state);
    p.parse(Uint8Array.of(data[i]));
  }
  states.push(p.state);
  return { states, dispatcher: e };
}

Deno.test("parser - ping", () => {
  const states = [
    State.OP_START,
    State.OP_P,
    State.OP_PI,
    State.OP_PIN,
    State.OP_PING,
    State.OP_PING,
    State.OP_START,
  ];
  const results = byByteTest(te.encode("PING\r\n"));
  assertEquals(results.states, states);
  assertEquals(results.dispatcher.pings, 1);
  assertEquals(results.dispatcher.count, 1);

  const events = new TestDispatcher();
  const p = new Parser(events);
  p.parse(te.encode("PING\r\n"));
  assertEquals(p.state, State.OP_START);

  p.parse(te.encode("PING \r"));
  assertEquals(p.state, State.OP_PING);

  p.parse(te.encode("PING \r \n"));
  assertEquals(p.state, State.OP_START);

  assertEquals(events.pings, 2);
  assertEquals(events.count, 2);
});

Deno.test("parser - err", () => {
  const states = [
    State.OP_START,
    State.OP_MINUS,
    State.OP_MINUS_E,
    State.OP_MINUS_ER,
    State.OP_MINUS_ERR,
    State.OP_MINUS_ERR_SPC,
    State.MINUS_ERR_ARG,
    State.MINUS_ERR_ARG,
    State.MINUS_ERR_ARG,
    State.MINUS_ERR_ARG,
    State.MINUS_ERR_ARG,
    State.MINUS_ERR_ARG,
    State.MINUS_ERR_ARG,
    State.MINUS_ERR_ARG,
    State.MINUS_ERR_ARG,
    State.MINUS_ERR_ARG,
    State.MINUS_ERR_ARG,
    State.OP_START,
  ];
  const results = byByteTest(te.encode(`-ERR '234 6789'\r\n`));
  assertEquals(results.states, states);
  assertEquals(results.dispatcher.errs.length, 1);
  assertEquals(results.dispatcher.count, 1);
  assertEquals(td.decode(results.dispatcher.errs[0].data), `'234 6789'`);

  const events = new TestDispatcher();
  const p = new Parser(events);
  p.parse(te.encode("-ERR 'Any error'\r\n"));
  assertEquals(p.state, State.OP_START);
  assertEquals(events.errs.length, 1);
  assertEquals(events.count, 1);
  assertEquals(td.decode(events.errs[0].data), `'Any error'`);
});

Deno.test("parser - ok", () => {
  let states = [
    State.OP_START,
    State.OP_PLUS,
    State.OP_PLUS_O,
    State.OP_PLUS_OK,
    State.OP_PLUS_OK,
    State.OP_START,
  ];
  let result = byByteTest(te.encode("+OK\r\n"));
  assertEquals(result.states, states);

  states = [
    State.OP_START,
    State.OP_PLUS,
    State.OP_PLUS_O,
    State.OP_PLUS_OK,
    State.OP_PLUS_OK,
    State.OP_PLUS_OK,
    State.OP_PLUS_OK,
    State.OP_START,
  ];
  result = byByteTest(te.encode("+OKay\r\n"));

  assertEquals(result.states, states);
});

Deno.test("parser - info", () => {
  const states = [
    State.OP_START,
    State.OP_I,
    State.OP_IN,
    State.OP_INF,
    State.OP_INFO,
    State.OP_INFO_SPC,
    State.INFO_ARG,
    State.INFO_ARG,
    State.INFO_ARG,
    State.OP_START,
  ];

  const results = byByteTest(te.encode(`INFO {}\r\n`));
  assertEquals(results.states, states);
  assertEquals(results.dispatcher.infos.length, 1);
  assertEquals(results.dispatcher.count, 1);
});

Deno.test("parser - errors", () => {
  const bad = [
    " PING",
    "POO",
    "Px",
    "PIx",
    "PINx",
    "PONx",
    "ZOO",
    "Mx\r\n",
    "MSx\r\n",
    "MSGx\r\n",
    "MSG foo\r\n",
    "MSG \r\n",
    "MSG foo 1\r\n",
    "MSG foo bar 1\r\n",
    "MSG foo bar 1 baz\r\n",
    "MSG foo 1 bar baz\r\n",
    "+x\r\n",
    "+0x\r\n",
    "-x\r\n",
    "-Ex\r\n",
    "-ERx\r\n",
    "-ERRx\r\n",
  ];

  let count = 0;
  bad.forEach((s) => {
    assertThrows(() => {
      count++;
      const p = new Parser(new NoopDispatcher());
      p.parse(te.encode(s));
    });
  });

  assertEquals(count, bad.length);
});

Deno.test("parser - split msg", () => {
  assertThrows(() => {
    const p = new Parser(new NoopDispatcher());
    p.parse(te.encode("MSG a\r\n"));
  });

  assertThrows(() => {
    const p = new Parser(new NoopDispatcher());
    p.parse(te.encode("MSG a b c\r\n"));
  });

  const d = new TestDispatcher();
  const p = new Parser(d);
  p.parse(te.encode("MSG a"));
  assert(p.argBuf);
  p.parse(te.encode(" 1 3\r\nf"));
  assertEquals(p.ma.size, 3, "size");
  assertEquals(p.ma.sid, 1, "sid");
  assertEquals(p.ma.subject, te.encode("a"), "subject");
  assert(p.msgBuf, "should message buffer");
  p.parse(te.encode("oo\r\n"));
  assertEquals(d.count, 1);
  assertEquals(d.msgs.length, 1);
  assertEquals(td.decode(d.msgs[0].msg?.subject), "a");
  assertEquals(td.decode(d.msgs[0].data), "foo");
  assertEquals(p.msgBuf, undefined);

  p.parse(te.encode("MSG a 1 3\r\nba"));
  assertEquals(p.ma.size, 3, "size");
  assertEquals(p.ma.sid, 1, "sid");
  assertEquals(p.ma.subject, te.encode("a"), "subject");
  assert(p.msgBuf, "should message buffer");
  p.parse(te.encode("r\r\n"));
  assertEquals(d.msgs.length, 2);
  assertEquals(td.decode(d.msgs[1].data), "bar");
  assertEquals(p.msgBuf, undefined);

  p.parse(te.encode("MSG a 1 6\r\nfo"));
  assertEquals(p.ma.size, 6, "size");
  assertEquals(p.ma.sid, 1, "sid");
  assertEquals(p.ma.subject, te.encode("a"), "subject");
  assert(p.msgBuf, "should message buffer");
  p.parse(te.encode("ob"));
  p.parse(te.encode("ar\r\n"));

  assertEquals(d.msgs.length, 3);
  assertEquals(td.decode(d.msgs[2].data), "foobar");
  assertEquals(p.msgBuf, undefined);

  const payload = new Uint8Array(100);
  const buf = te.encode("MSG a 1 b 103\r\nfoo");
  p.parse(buf);
  assertEquals(p.ma.size, 103);
  assertEquals(p.ma.sid, 1);
  assertEquals(td.decode(p.ma.subject), "a");
  assertEquals(td.decode(p.ma.reply), "b");
  assert(p.argBuf);
  const a = "a".charCodeAt(0); //97
  for (let i = 0; i < payload.length; i++) {
    payload[i] = a + (i % 26);
  }
  p.parse(payload);
  assertEquals(p.state, State.MSG_PAYLOAD);
  assertEquals(p.ma.size, 103);
  assertEquals(p.msgBuf.length, 103);
  p.parse(te.encode("\r\n"));
  assertEquals(p.state, State.OP_START);
  assertEquals(p.msgBuf, undefined);
  assertEquals(d.msgs.length, 4);
  const db = d.msgs[3].data!;
  assertEquals(td.decode(db.subarray(0, 3)), "foo");
  const gen = db.subarray(3);
  for (let k = 0; k < 100; k++) {
    assertEquals(gen[k], a + (k % 26));
  }
});

Deno.test("parser - info arg", () => {
  const arg = {
    "server_id": "test",
    host: "localhost",
    port: 4222,
    version: "1.2.3",
    "auth_required": true,
    "tls_required": true,
    "max_payload": 2 * 1024 * 1024,
    "connect_urls": [
      "localhost:5222",
      "localhost:6222",
    ],
  };

  const d = new TestDispatcher();
  const p = new Parser(d);
  const info = te.encode(`INFO ${JSON.stringify(arg)}\r\n`);

  p.parse(info.subarray(0, 9));
  assertEquals(p.state, State.INFO_ARG);
  assert(p.argBuf);

  p.parse(info.subarray(9, 11));
  assertEquals(p.state, State.INFO_ARG);
  assert(p.argBuf);

  p.parse(info.subarray(11));
  assertEquals(p.state, State.OP_START);
  assertEquals(p.argBuf, undefined);

  assertEquals(d.infos.length, 1);
  assertEquals(d.count, 1);

  const arg2 = JSON.parse(td.decode(d.infos[0]?.data));
  assertEquals(arg2, arg);

  const good = [
    "INFO {}\r\n",
    "INFO  {}\r\n",
    "INFO {} \r\n",
    'INFO { "server_id": "test"  }   \r\n',
    'INFO {"connect_urls":[]}\r\n',
  ];
  good.forEach((info) => {
    p.parse(te.encode(info));
  });
  assertEquals(d.infos.length, good.length + 1);

  const bad = [
    "IxNFO {}\r\n",
    "INxFO {}\r\n",
    "INFxO {}\r\n",
    "INFOx {}\r\n",
    "INFO{}\r\n",
    "INFO {}",
  ];

  let count = 0;
  bad.forEach((info) => {
    assertThrows(() => {
      count++;
      p.parse(te.encode(info));
    });
  });
  assertEquals(count, bad.length);
});

Deno.test("parser - header", () => {
  const d = new TestDispatcher();
  const p = new Parser(d);
  const h = headers() as MsgHdrsImpl;
  h.set("x", "y");
  const hdr = h.encode();

  p.parse(te.encode(`HMSG a 1 ${hdr.length} ${hdr.length + 3}\r\n`));
  p.parse(hdr);
  assertEquals(p.ma.size, hdr.length + 3, "size");
  assertEquals(p.ma.sid, 1, "sid");
  assertEquals(p.ma.subject, te.encode("a"), "subject");
  assert(p.msgBuf, "should message buffer");
  p.parse(te.encode("bar\r\n"));

  assertEquals(d.msgs.length, 1);
  const payload = d.msgs[0].data;
  const h2 = MsgHdrsImpl.decode(payload!.subarray(0, d.msgs[0].msg?.hdr));
  assert(h2.equals(h));
  assertEquals(td.decode(payload!.subarray(d.msgs[0].msg?.hdr)), "bar");
});

Deno.test("parser - subject", () => {
  const d = new TestDispatcher();
  const p = new Parser(d);
  p.parse(
    te.encode(
      `MSG foo 1 _INBOX.4E66Z7UREYUY9VKDNFBT1A.4E66Z7UREYUY9VKDNFBT72.4E66Z7UREYUY9VKDNFBSVI 102400\r\n`,
    ),
  );
  for (let i = 0; i < 100; i++) {
    p.parse(new Uint8Array(1024));
  }
  assertEquals(p.ma.size, 102400, `size ${p.ma.size}`);
  assertEquals(p.ma.sid, 1, "sid");
  assertEquals(p.ma.subject, te.encode("foo"), "subject");
  assertEquals(
    p.ma.reply,
    te.encode(
      "_INBOX.4E66Z7UREYUY9VKDNFBT1A.4E66Z7UREYUY9VKDNFBT72.4E66Z7UREYUY9VKDNFBSVI",
    ),
    "reply",
  );
});

Deno.test("parser - msg buffers don't clobber", () => {
  parserClobberTest(false);
});

Deno.test("parser - hmsg buffers don't clobber", () => {
  parserClobberTest(true);
});

function parserClobberTest(hdrs = false): void {
  const d = new TestDispatcher();
  const p = new Parser(d);

  const a = "a".charCodeAt(0);
  const fill = (n: number, b: Uint8Array) => {
    const v = n % 26 + a;
    for (let i = 0; i < b.length; i++) {
      b[i] = v;
    }
  };

  const code = (n: number): number => {
    return n % 26 + a;
  };

  const subj = new Uint8Array(26);
  const reply = new Uint8Array(26);
  const payload = new Uint8Array(1024 * 1024);
  const kv = new Uint8Array(12);

  const check = (n: number, m: Msg) => {
    const s = code(n + 1);
    assertEquals(m.subject.length, subj.length);
    te.encode(m.subject).forEach((c) => {
      assertEquals(c, s, "subject char");
    });

    const r = code(n + 2);
    assertEquals(m.reply?.length, reply.length);
    te.encode(m.reply).forEach((c) => {
      assertEquals(r, c, "reply char");
    });
    assertEquals(m.data.length, payload.length);
    const pc = code(n);
    m.data.forEach((c) => {
      assertEquals(c, pc);
    }, "payload");

    if (hdrs) {
      assert(m.headers);
      fill(n + 3, kv);
      const hv = td.decode(kv);
      assertEquals(m.headers.get(hv), hv);
    }
  };

  const buf = new DenoBuffer();
  const N = 100;
  for (let i = 0; i < N; i++) {
    buf.reset();
    fill(i, payload);
    fill(i + 1, subj);
    fill(i + 2, reply);
    let hdrdata = Empty;
    if (hdrs) {
      fill(i + 3, kv);
      const h = headers() as MsgHdrsImpl;
      const kvs = td.decode(kv);
      h.set(kvs, kvs);
      hdrdata = h.encode();
    }
    const len = hdrdata.length + payload.length;

    if (hdrs) {
      buf.writeString("HMSG ");
    } else {
      buf.writeString("MSG ");
    }
    buf.write(subj);
    buf.writeString(` 1`);
    if (reply) {
      buf.writeString(" ");
      buf.write(reply);
    }
    if (hdrs) {
      buf.writeString(` ${hdrdata.length}`);
    }
    buf.writeString(` ${len}\r\n`);
    if (hdrs) {
      buf.write(hdrdata);
    }
    buf.write(payload);
    buf.writeString(`\r\n`);

    p.parse(buf.bytes());
  }

  assertEquals(d.msgs.length, 100);
  for (let i = 0; i < 100; i++) {
    const e = d.msgs[i];
    const m = new MsgImpl(e.msg!, e.data!, {} as Publisher);
    check(i, m);
  }
}
