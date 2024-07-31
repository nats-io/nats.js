# Migration Guide

The NATS ecosystem has grown a lot since the 2.0 release of the `nats` (nats.js)
client. NATS currently runs in several JavaScript runtimes: Deno, Browser, and
Node (Bun).

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

In order to satisfy those needs, the NATS JavaScript library has split into
separate libraries which focus on:

- NatsCore `@nats-io/nats-core` - publish/subscribe/request-reply.
- JetStream `@nats-io/jetstream` (depends on `@nats-core`)
- KV `@nats-io/kv` (depends on JetStream)
- ObjectStore `@nats-io/obj` (depends on JetStream)
- Services `@nats-io/services` (depends on NatsCore)

The transports have also been migrated:

- `@nats-io/transport-node` has all the functionality of the original `nats.js`
- `@nats-io/transport-deno` has all the functionality of `nats.deno`
- `nats.ws` is now part of `@nats-io/nats-core` as it can be used from Deno or
  latest version of Node directly.

Note that when installing `@nats-io/transport-node` or
`@nats-io/transport-deno`, the `@nats-io/core` APIs are also made available.

Your library selection process will start by selecting your runtime, and
importing any additional functionality you may be interested in. The
`@nats-io/node`, `@nats-io/deno`, `@nats-io/es-websocket` depend and re-export
`@nats-io/core`.

To use the extended functionality (JetStream, KV, ObjectStore, Services) you
will need to install and import from the other libraries and call API to create
an instance of the functionality the need.

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

## Changes to Clients

- [Deno](./transport-deno/README.md)
- [Node](./transport-node/README.md)
- [W3C Websocket](./core/README.md) - the client can be created in a compliant
  runtime via the [`wsconnect`]() function

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
  `KV` or `ObjectStore` library.
- `jetstreamManager.listKvs()` and `jetstreamManager.listObjectStores()` apis
  have been removed. Use the `list()` methods provided the `Kvm` and `ObjM` APIs
  instead.
- `JetStreamClient#subscribe()`, `JetStreamClient#fetch()` have been removed.
  Use the `Consumers` API to `get()` your consumer.

## Changes to KV

To use KV, you must install and import `@nats-io/kv`, and create an instance of
Kvm:

```typescript
import { connect } from "@nats-io/transport-deno";
import { jetstream } from "@nats-io/jetstream";
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

> [!CAUTION]
>
> Clients prior to 3.x used to shim the global `crypto` automatically. `crypto`
> is available on node 20 and better. Please upgrade your node runtime or shim
> `crypto`:
>
> ```javascript
> if (typeof globalThis.crypto === "undefined") {
>   const c = require("crypto");
>   global.crypto = c.webcrypto;
> }
> ```

To use ObjectStore, you must install and import `@nats-io/obj`.

## Changes to Services Framework

To use services, you must install and import `@nats-io/services`, and create an
instance of Svc, which allows you to `add()` a service and create a
ServiceClient `client(nc)`:

```typescript
const svc = new Svc(nc);
const service = await svc.add({
  name: "max",
  version: "0.0.1",
  description: "returns max number in a request",
  statsHandler,
});

// other manipulation as per service api...
```
