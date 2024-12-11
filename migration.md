# Migration Guide

The NATS ecosystem has grown a lot since the 2.0 release of the `nats` (nats.js)
client. NATS currently runs in several JavaScript runtimes: Deno, Browser, and
Node/Bun.

While the organization of the library has served developers well, there are a
number of issues we would like to address going forward:

- Strict SemVer on the libraries. Any API break will signal a major version
  bump, this will allow you to opt-in on upgrades knowing that major version
  bumps may require updating your code.
- Better presentation of NATS technologies to developers that are interested in
  KV, ObjectStore or JetStream.
- Smaller dependencies for those that are only interested in the NATS core
  functionality.
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
  latest version of Node directly or any runtime that has standard W3C Websocket
  support.

Note that when installing `@nats-io/transport-node` or
`@nats-io/transport-deno`, the `@nats-io/core` APIs are also made available.

Your library selection process will start by selecting your runtime, and
importing any additional functionality you may be interested in. The
`@nats-io/transport-node`, `@nats-io/transport-deno` depend on and re-export
`@nats-io/core`.

To use the extended functionality (JetStream, KV, ObjectStore, Services) you
will need to install and import from the other libraries to access those APIs.

For example, developers that use JetStream can access it by using the functions
`jetstream()` and `jetstreamManager()` and provide their NATS connection. Note
that the `NatsConnection#jetstream/Manager()` APIs are no longer available.

Developers interested in KV or ObjectStore can access the resources by calling
creating a Kvm and calling `create()` or `open()` using either a
`JetStreamClient` or a plain `NatsConnection`. Note that the
`JetStreamClient#views` API is also no longer available.

Other add-ons such as those found in `Orbit.js` will require an interface
(NatsConnection, JetStreamClient, etc) reducing the complexity for packaging
these modules for cross-runtime consumption.

## Changes to Clients

- [Deno](./transport-deno/README.md)
- [Node](./transport-node/README.md)
- [W3C Websocket](./core/README.md) - the client can be created in a compliant
  runtime via the
  [`wsconnect`](https://nats-io.github.io/nats.js/core/functions/wsconnect.html)
  function

## Changes in Nats Base Client

- QueuedIterator type incorrectly exposed a `push()` operation - this operation
  is not public API and was removed from the interface.
- The internal type `TypedSubscription` and associated interfaces have been
  removed, these were supporting legacy JetStream APIs
  (`subscribe/pullSubscribe()`. If you were using these internal types to
  transform the types in the subscription, take a look at
  [messagepipeline](https://github.com/synadia-io/orbit.js/tree/main/messagepipeline).
- The utilities `JSONCodec` and `StringCodec` have been removed, the `Msg` types
  and derivatives can set string or Uint8Array payloads. To read payloads as
  string or JSON use `string()` and `json()` methods on Msg or its derivatives.
  For publishing JSON payloads, simply specify the output of `JSON.stringify()`
  to the publish or request operation.
- NatsError was removed in favor of more descriptive types. For example, if you
  make a request, the request could fail with a RequestError or TimeoutError.
  The RequestError in turn will contain the `cause` such as `NoRespondersError`.
  This also means that in TypeScript, the callback signature has been relaxed to
  just `(Error, Msg)=>void`. For more information see the JsDocs.
- Previous versions of the client provided the enums `Events` and `DebugEvents`
  for the `type` values in the notification received via
  `status(): AsyncIterable<Status>` iterator. Starting with this release,
  reported status provide their own types which means that they provide richer
  data and are easier to use from different modules, since you can provide the
  string name of the type. For more information see
  [Lifecycle and Informational and Events](core/README.md#lifecycle-and-informational-events)
- Subscription#closed now resolves to void or an Error (it doesn't throw). The
  error is the reason why the subscription closed.
- RequestStrategy "Jitter" is now called "stall" to adopt the term used by new
  implementations in other clients and the RequestStrategy enum is now a type
  alias to simple strings "timer", "count", "stall", "sentinel".
- `SHA256` a support type for object store has been moved to @nats-io/obj
- `Base64Codec`, `Base64UrlCodec`, `Base64UrlPaddedCodec` support types for
  object store have been moved to @nats-io/obj.

## Changes in JetStream

To use JetStream, you must install and import `@nats/jetstream`.

- `jetStream()` and `jetStreamManager()` functions on the `NatsConnection` have
  been removed. Install and import the `JetStream` library, and call
  `jetstream(nc: NatsConnection)` or `jetstreamManager(nc: NatsConnection)`
- The `views` property in the JetStream client has been removed - install the
  `KV` or `ObjectStore` library.
- `jetstreamManager.listKvs()` and `jetstreamManager.listObjectStores()` apis
  have been removed. Use the `list()` methods provided the `Kvm` and `ObjM` APIs
  instead.
- `JetStreamClient#subscribe()`, `JetStreamClient#fetch()` have been removed.
  Use the `Consumers` API to `get()` your consumer.
- `OrderedConsumerOptions#filterSubjects` changed to
  `OrderedConsumerOptions#filter_subjects`.
- Consumer.status() now returns `AsyncIterable<ConsumerStatus>` instead of a
  `Promise<AsyncIterable<ConsumerStatus>>`
- `JetStreamClient.pull()` was deprecated and was removed. Use
  `Consumer.next()`.
- The utility function `consumerOpts()` and associated function
  `isConsumerOptsBuilder()` have been removed. Alongside of it
  `ConsumerOptsBuilder` which was used by `subscribe()` and `pullSubscribe()`
  type has also been removed.
- JetStream errors are now expressed by the type `JetStreamError` and
  `JetStreamAPIError`. Common errors such as `ConsumerNotFound`, and
  `StreamNotFound`, `JetStreamNotEnabled` are subtypes of the above. For API
  calls where the server could return an error, these are `JetStreamAPIError`
  and contain all the information returned by the server.
- JetStream `Stream.getMessage()` will now return null if when a message not
  found error raises, this simplifies client usage and aligns with other APIs in
  the client.
- MsgRequest for `Stream#getMessage()` removed deprecated number argument.
- For non-ordered consumers next/fetch() can will now throw/reject when
  heartbeats are missed.
- The `ConsumerEvents` and `ConsumerDebugEvents` enum has been removed and
  replaced with `ConsumerNotification` which have a discriminating field `type`.
  The status objects provide a more specific API for querying those events.
- The JsMsg.next() API has been retracted as the simplified consumer `next()`,
  and `consume()` provide the necessary functionality.

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

### KvWatchOption.initializedFn has been removed

Previous versions of `Kv.watch()` allowed the client to specify a function that
was called when the watch was done providing history values. In this version,
you can find out if a watch is yielding an update by examining the `isUpdate`
property. Note that an empty Kv will not yield any watch information. You can
test for this initial condition, by getting the status of the KV, and inspecting
the `values` property, which will state the number of entries in the Kv. Also
note that watches with the option to do updates only, cannot notify until
there's an update.

### Removal of deprecations

Removed deprecated KV apis (`KvRemove` - `remove(k)=>Promise<void>`,
`close()=>Promise<void>`) and options (`maxBucketSize`,
`placementCluster`,`bucket_location`)

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

### Watch

Object.watch() now returns an `ObjectWatchInfo` which is an `ObjectInfo` but
adding the property `isUpdate` this property is now true when the watch is
notifying of a new entry. Note that previously the iterator would yield
`ObjectInfo | null`, the `null` signal has been removed. This means that when
doing a watch on an empty ObjectStore you won't get an update notification until
an actual value arrives.

### Removed deprecations

Removed deprecated `ObjectStoreInfo` - use `ObjectStoreStatus`

## Changes to Services Framework

To use services, you must install and import `@nats-io/services`, and create an
instance of Svc, which allows you to `add()` a service and create a
ServiceClient `client(nc)`:

```typescript
const svc = new Svcm(nc);
const service = await svc.add({
  name: "max",
  version: "0.0.1",
  description: "returns max number in a request",
  statsHandler,
});

// other manipulation as per service api...
```

- `services` property has been removed. Install and import the `Services`
  library, and call `Svcm(nc: NatsConnection)`
