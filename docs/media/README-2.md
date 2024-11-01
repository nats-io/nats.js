# kv

The kv module implements the NATS KV functionality using JetStream for
JavaScript clients. JetStream clients can use streams to store and access data.
KV is materialized view that presents a different _API_ to interact with the
data stored in a stream using the API for a Key-Value store which should be
familiar to many application developers.

## Installation

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
deno add @nats-io/kv
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
await kv.put("hello.world", sc.encode("world"));
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
