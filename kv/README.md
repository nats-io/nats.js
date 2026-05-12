[![License](https://img.shields.io/badge/Licence-Apache%202.0-blue.svg)](./LICENSE)
[![kv](https://github.com/nats-io/nats.js/actions/workflows/test.yml/badge.svg)](https://github.com/nats-io/nats.js/actions/workflows/test.yml)
[![JSDoc](https://img.shields.io/badge/JSDoc-reference-blue)](https://nats-io.github.io/nats.js/kv/index.html)

[![JSR](https://jsr.io/badges/@nats-io/kv)](https://jsr.io/@nats-io/kv)
[![JSR](https://jsr.io/badges/@nats-io/kv/score)](https://jsr.io/@nats-io/kv)

[![NPM Version](https://img.shields.io/npm/v/%40nats-io%2Fkv)](https://www.npmjs.com/package/@nats-io/kv)
[![NPM Downloads](https://img.shields.io/npm/dt/%40nats-io%2Fkv)](https://www.npmjs.com/package/@nats-io/kv)
[![NPM Downloads](https://img.shields.io/npm/dm/%40nats-io%2Fkv)](https://www.npmjs.com/package/@nats-io/kv)

# kv

The kv module implements the NATS KV functionality using JetStream for
JavaScript clients. JetStream clients can use streams to store and access data.
KV is materialized view that presents a different _API_ to interact with the
data stored in a stream using the API for a Key-Value store which should be
familiar to many application developers.

## Installation

For a quick overview of the libraries and how to install them, see
[runtimes.md](../runtimes.md).

Note that this library is distributed in two different registries:

- npm a node-specific library supporting CJS (`require`) and ESM (`import`)
- jsr a node and other ESM (`import`) compatible runtimes (deno, browser, node)

If your application doesn't use `require`, you can simply depend on the JSR
version.

### NPM

The NPM registry hosts a node-only compatible version of the library
[@nats-io/kv](https://www.npmjs.com/package/@nats-io/kv) supporting both CJS and
ESM:

```bash
npm install @nats-io/kv
```

### JSR

The JSR registry hosts the ESM-only [@nats-io/kv](https://jsr.io/@nats-io/kv)
version of the library.

```bash
deno jsr:add @nats-io/kv
```

```bash
npx jsr add @nats-io/kv
```

```bash
yarn dlx jsr add @nats-io/kv
```

```bash
bunx jsr add @nats-io/kv
```

## Referencing the library

Once you import the library, you can reference in your code as:

```javascript
import { Kvm } from "@nats-io/kv";

// or in node (only when using CJS)
const { Kvm } = require("@nats-io/kv");

// using a nats connection:
const kvm = new Kvm(nc);
await kvm.list();
await kvm.create("mykv");
```

If you want to customize some of the JetStream options when working with KV, you
can:

```typescript
import { jetStream } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";

const js = jetstream(nc, { timeout: 10_000 });
// KV will inherit all the options from the JetStream client
const kvm = new Kvm(js);
```

```typescript
// create the named KV or bind to it if it exists:
const kvm = new Kvm(nc);
const kv = await kvm.create("testing", { history: 5 });
// if the kv is expected to exist:
// const kv = await kvm.open("testing");

// create an entry - this is similar to a put, but will fail if the
// key exists
const hw = await kv.create("hello.world", "hi");

// Values in KV are stored as KvEntries:
// {
//   bucket: string,
//   key: string,
//   value: Uint8Array,
//   created: Date,
//   revision: number,
//   delta?: number,
//   operation: "PUT"|"DEL"|"PURGE"
// }
// The operation property specifies whether the value was
// updated (PUT), deleted (DEL) or purged (PURGE).

// you can monitor values modification in a KV by watching.
// You can watch specific key subset or everything.
// Watches start with the latest value for each key in the
// set of keys being watched - in this case all keys
const watch = await kv.watch();
(async () => {
  for await (const e of watch) {
    // do something with the change
    console.log(
      `watch: ${e.key}: ${e.operation} ${e.value ? e.string() : ""}`,
    );
  }
})().then();

// update the entry
await kv.put("hello.world", "world");
// retrieve the KvEntry storing the value
// returns null if the value is not found
const e = await kv.get("hello.world");
// initial value of "hi" was overwritten above
console.log(`value for get ${e?.string()}`);

const buf: string[] = [];
const keys = await kv.keys();
await (async () => {
  for await (const k of keys) {
    buf.push(k);
  }
})();
console.log(`keys contains hello.world: ${buf[0] === "hello.world"}`);

let h = await kv.history({ key: "hello.world" });
await (async () => {
  for await (const e of h) {
    // do something with the historical value
    // you can test e.operation for "PUT", "DEL", or "PURGE"
    // to know if the entry is a marker for a value set
    // or for a deletion or purge.
    console.log(
      `history: ${e.key}: ${e.operation} ${e.value ? sc.decode(e.value) : ""}`,
    );
  }
})();

// deletes the key - the delete is recorded
await kv.delete("hello.world");

// purge is like delete, but all history values
// are dropped and only the purge remains.
await kv.purge("hello.world");

// stop the watch operation above
watch.stop();

// danger: destroys all values in the KV!
await kv.destroy();
```

## Per-Key TTLs

Server 2.11+ supports automatic key removal. Enabled by creating the bucket with
the `markerTTL` option (milliseconds, minimum 1000). Setting it does two things
on the backing stream:

- enables per-message TTLs (`allow_msg_ttl = true`)
- when a key is removed by `max_age` or a per-key TTL, the server emits a
  tombstone marker; `markerTTL` is how long that auto-emitted marker stays in
  the bucket before the server removes it too

Per-key TTL is exposed in two places only:

- `kv.create(key, value, "<duration>")` — first write only
- `kv.purge(key, { ttl: "<duration>" })` — lifetime of the purge marker

Duration is a string: `2s`, `2m`, `1.5h`. A bare number means seconds. Minimum
resolution is one second; See https://pkg.go.dev/time#ParseDuration for more
information. `put()` does not accept a TTL — if it did, expiry of the latest
revision could surface an older history entry.

### Purge with a TTL on the marker

```typescript
// markerTTL on the bucket is required for any per-key/marker TTL to work
const kv = await new Kvm(js).create("A", { markerTTL: 2_000 });
await kv.create("k", "hello");

// purge rolls up history immediately; the purge marker itself is removed
// after 2s thanks to the per-call ttl
await kv.purge("k", { ttl: "2s" });

// ~2s later the marker is gone and the key is invisible to new watchers/gets
```

### Bucket-wide TTL with auto-emitted markers

```typescript
// bucket-wide ttl (max_age) makes every entry live at most 1s;
// markerTTL keeps the auto-emitted tombstone for 2s after expiry
const kv = await new Kvm(js).create("A", { markerTTL: 2_000, ttl: 1_000 });

await kv.create("k", "hello");

// deferred can be imported from @nats-io/nats-core
const d = deferred();
const now = Date.now();
const iter = await kv.watch();
(async () => {
  for await (const e of iter) {
    console.log(Date.now() - now, e.operation, e.key);
    // server emits a marker with Nats-Marker-Reason: MaxAge,
    // which the client maps to PURGE
    if (e.operation === "PURGE") {
      d.resolve();
    }
  }
})().catch();
await d;

// after markerTTL elapses the marker is also gone
// delay can be imported from @nats-io/nats-core
await delay(2500);
const e = await kv.get("k");
console.log(e ? "key still found" : "key is gone");
```

### Per-key TTL on create

```typescript
const kv = await new Kvm(js).create("A", { markerTTL: 2_000 });

// per-key TTL is a duration string ("5s", "1m", "1.5h"); minimum 1s
await kv.create("k", "hello", "5s");

// deferred can be imported from @nats-io/nats-core
const d = deferred();
const now = Date.now();
const iter = await kv.watch();
(async () => {
  for await (const e of iter) {
    console.log(Date.now() - now, e.operation, e.key);
    // ~5s after create the server removes the entry and emits a marker
    if (e.operation === "PURGE") {
      d.resolve();
    }
  }
})().catch();
await d;

// marker itself disappears after the bucket's markerTTL
// delay can be imported from @nats-io/nats-core
await delay(2500);
const e = await kv.get("k");
console.log(e ? "key still found" : "key is gone");
```
