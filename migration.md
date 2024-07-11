# Migration Guide

The NATS ecosystem has grown a lot since the 2.0 release of the `nats` (nats.js)
client. NATS is currently running in several JavaScript runtimes: Deno, Browser,
and Node (Bun).

While the organization of the library has served developers well, there are a
number of issues we would like to address going forward:

- Strict SemVer on the libraries. Any API break will signal a major version
  bump, this will allow you to opt-in on upgrades knowing that major version
  bumps may require updating your code.
- Better presentation of NATS technologies to developers that are interested in
  KV, ObjectStore or JetStream.
- Smaller dependencies for those that are only interested in the NATS core
  functionality (no JetStream)
- More agility and independence to each of the modules, as well as their own
  version.
- Easier understanding of the functionality in question, as each repository
  hosting the individual libraries will focus on the API provided by that
  library.
- Reduce framework dependency requirements where possible.

In order to satisfy those needs, the NATS JavaScript library will split into
separate libraries which focus on:

- Transport Libraries (nats.js - `@nats-io/node`, nats.deno `@nats-io/deno`,
  nats.ws `@nats/websocket`) - these depend on NatsCore, and only contribute a
  transport implementation.
- NatsCore `@nats-io/core` ("nats-base-client") -
  publish/subscribe/request-reply.
- JetStream `@nats-io/jetstream` (depends on `@nats-core`)
- KV `@nats-io/kv` (depends on JetStream)
- ObjectStore `@nats-io/obj` (depends on JetStream)
- Services `@nats-io/services` (depends on NatsCore)

Your library selection process will start by selecting your runtime, and
importing any additional functionality you may be interested in. The
`@nats-io/node`, `@nats-io/deno`, `@nats-io/es-websocket` depend and re-export
`@nats-io/core`.

To use the extended functionality you will need to install and import from the
other libraries and call API to create an instance of the functionality the
need.

For example, developers that use JetStream can access it by using the functions
`jetstream()` and `jetstreamManager()` and provide their NATS connection. Note
that the `NatsConnection#jetstream/Manager()` APIs are no longer available.

Developers interested in KV or ObjectStore can access the resources by calling
creating a Kvm and calling `create()` or `open()` using wither a
`JetStreamClient` or a plain `NatsConnection`. Note that the
`JetStreamClient#views` API is also no longer available.

Other add-ons such as those found in `Orbit.js` will require an interface
(NatsConnection, JetStreamClient, etc) reducing the complexity for packaging
these modules for cross-runtime consumption.

## Changes in Nats Base Client

- QueuedIterator type incorrectly exposed a `push()` operation - this operation
  is not public API and was removed from the interface.

## Changes in JetStream

To use JetStream, you must install and import `@nats/jetstream`.

- `jetStream()` and `jetStreamManager()` functions on the `NatsConnection` have
  been removed. Install and import the `JetStream` library, and call
  `jetstream(nc: NatsConnection)` or `jetstreamManager(nc: NatsConnection)`
- `services` property has been removed. Install and import the `Services`
  library, and call `services(nc: NatsConnection)`

- The `views` property in the JetStream client has been removed - install the
  `Kv` or `ObjectStore` library.
- `jetstreamManager.listKvs()` and `jetstreamManager.listObjectStores()` apis
  have been removed. Use the `list()` methods provided the `Kvm` and `ObjM` APIs
  instead.
- `JetStreamClient#subscribe()`, `JetStreamClient#fetch()` have been removed.
  Use the `Consumers` API to `get()` your consumer.

## Changes to KV

To use KV, you must install and import `@nats-io/kv`, and create an instance of
Kvm:

```typescript
import { connect } from "@nats-deno/mod.ts";
import { jetstream } from "@nats-jetstream/mod.ts";
import { Kvm } from "@nats-io/kv";
const nc = await connect();
let kvm = new Kvm(nc);
// or create a JetStream which allows you to specify jetstream options
const js = jetstream(nc, { timeout: 3000 });
kvm = new Kvm(js);

// To list KVs:
await kvm.list();

// To create a KV and open it:
await kvm.create("mykv");

// To access a KV but fail if it doesn't exist:
await kvm.open("mykv");
```

## Changes to ObjectStore

> [!CAUTION] Clients prior to 3.x used to shim the global `crypto` automatically.
> `crypto` is available on node 20 and better. Please upgrade your node runtime or
> shim `crypto`:
> 
>  if (typeof globalThis.crypto === "undefined") {
>    const c = require("crypto");
>    // this will patch to undefined if webcrypto is not available (node 14)
>    // views will toss if crypto is not available
>    global.crypto = c.webcrypto;
>  }

To use ObjectStore, you must install and import `@nats-io/obj`.
