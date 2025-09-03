[![License](https://img.shields.io/badge/Licence-Apache%202.0-blue.svg)](./LICENSE)
![nats-core](https://github.com/nats-io/nats.js/actions/workflows/test.yml/badge.svg)
[![JSDoc](https://img.shields.io/badge/JSDoc-reference-blue)](https://nats-io.github.io/nats.js/core/index.html)

[![JSR](https://jsr.io/badges/@nats-io/nats-core)](https://jsr.io/@nats-io/nats-core)
[![JSR](https://jsr.io/badges/@nats-io/nats-core/score)](https://jsr.io/@nats-io/nats-core)

[![NPM Version](https://img.shields.io/npm/v/%40nats-io%2Fnats-core)](https://www.npmjs.com/package/@nats-io/nats-core)
![NPM Downloads](https://img.shields.io/npm/dt/%40nats-io%2Fnats-core)
![NPM Downloads](https://img.shields.io/npm/dm/%40nats-io%2Fnats-core)

# Core

The _core_ module implements the _core_ functionality for JavaScript clients:

- Connection, authentication, connection lifecycle
- NATS protocol handling - messaging functionality (publish, subscribe and
  request reply)

A native transports (node, deno) modules are a peer module that export a
`connect` function which returns a concrete instance of a `NatsConnection`. The
transport library re-exports all the functionality in this module, to make it
the entry point into the NATS JavaScript ecosystem.

You can use this module as a runtime agnostic dependency and implement
functionality that uses a NATS client connection without binding your code to a
particular runtime. For example, the @nats-io/jetstream library depends on
@nats-io/nats-core to implement all of its JetStream protocol.

## WebSocket Support

The _core_ module also offers a for W3C Websocket transport (aka browser, Deno,
and Node v22) via the exported `wsconnect` function. This function is
semantically equivalent to the traditional `connect`, but returns a
`NatsConnection` that is backed by a W3C WebSocket.

Note that wsconnect assumes `wss://` connections. If you provide a port, it
likewise resolve to `wss://localhost:443`. If you specify a `ws://` URL, the
client assumes port 80, which is likely not the port. Check your server
configuration as the port for WebSocket protocol is NOT 4222.

# Installation

For a quick overview of the libraries and how to install them, see
[runtimes.md](../runtimes.md).

If you are not implementing a NATS client compatible module, you can use this
repository to view the documentation of the NATS core functionality. Your NATS
client instance already uses and re-exports the module implemented here, so
there's no need for you to directly depend on this library.

Note that this module is distributed in two different registries:

- npm a node-specific library supporting CJS (`require`) and ESM (`import`) for
  node specific projects
- jsr a node and other ESM (`import`) compatible runtimes (deno, browser, node)

If your application doesn't use `require`, you can simply depend on the JSR
version.

## NPM

The NPM registry hosts a node-only compatible version of the library
[@nats-io/nats-core](https://www.npmjs.com/package/@nats-io/nats-core)
supporting both CJS and ESM:

```bash
npm install @nats-io/nats-core
```

## JSR

The JSR registry hosts the ESM-only
[@nats-io/nats-core](https://jsr.io/@nats-io/nats-core) version of the library.

```bash
deno add jsr:@nats-io/nats-core
```

```bash
npx jsr add @nats-io/nats-core
```

```bash
yarn dlx jsr add @nats-io/nats-core
```

```bash
bunx jsr add @nats-io/nats-core
```

## Referencing the library

Once you import the library, you can reference in your code as:

```javascript
import * as nats_core from "@nats-io/nats-core";
// or in node (only when using CJS)
const nats_core = require("@nats-io/nats-core");
```

The main entry point for this library is the `NatsConnection`.

## Basics

### Connecting to a nats-server

To connect to a server you use the `connect()` exposed by your selected
transport. The connect function returns a connection which implements the
`NatsConnection` that you can use to interact with the server.

The `connect()` function will accept a `ConnectOptions` which customizes some of
the client behaviors. In general all options apply to all transports where
possible. Options that are non-sensical on a particular runtime will be
documented by your transport module.

By default, `connect()` will attempt a connection on `127.0.0.1:4222`. If the
connection is dropped, the client will attempt to reconnect. You can customize
the server you want to connect to by specifying `port` (for local connections),
or full hostport on the `servers` option. Note that the `servers` option can be
a single hostport (a string) or an array of hostports.

The example below will attempt to connect to different servers by specifying
different `ConnectionOptions`. At least two of them should work if your internet
is working.

```typescript
// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

const servers = [
  {},
  { servers: ["demo.nats.io:4442", "demo.nats.io:4222"] },
  { servers: "demo.nats.io:4443" },
  { port: 4222 },
  { servers: "localhost" },
];
servers.forEach(async (v) => {
  try {
    const nc = await connect(v);
    console.log(`connected to ${nc.getServer()}`);
    // this promise indicates the client closed
    const done = nc.closed();
    // do something with the connection

    // close the connection
    await nc.close();
    // check if the close was OK
    const err = await done;
    if (err) {
      console.log(`error closing:`, err);
    }
  } catch (_err) {
    console.log(`error connecting to ${JSON.stringify(v)}`);
  }
});
```

To disconnect from the nats-server, call `close()` on the connection. A
connection can also be terminated when an unexpected error happens. For example,
the server returns a run-time error. In those cases, the client will re-initiate
a connection, it the connection options allow it.

By default, the client will always attempt to reconnect if the connection is
disrupted for a reason other than calling `close()`. To get notified when the
connection is closed, await the resolution of the Promise returned by
`closed()`. If closed resolves to a value, the value is a `NatsError` indicating
why the connection closed.

### Publish and Subscribe

The basic NATS client operations are `publish` to send messages and `subscribe`
to receive messages.

Messages are published to a _subject_. A _subject_ is like a URL with the
exception that it doesn't specify an actual endpoint. Subjects can be any
string, but until you learn more about NATS stick to the simple rule that
subjects that are just simple ASCII printable letters and number characters. All
recipients that have expressed interest in a subject will receive messages
addressed to that subject (provided they have access and permissions to get it).
To express interest in a subject, you create a `subscription`.

In JavaScript clients subscriptions work as an async iterator - clients simply
loop to process messages as they happen.

NATS messages are payload agnostic. Payloads are `Uint8Arrays` or `string`.
Messages also provide a `string()` and `json()` that allows you to convert the
underlying `Uint8Array` into a string or parse by using `JSON.parse()` (which
can fail to parse if the payload is not the expected format).

To cancel a subscription and terminate your interest, you call `unsubscribe()`
or `drain()` on a subscription. Unsubscribe will typically terminate regardless
of whether there are messages in flight for the client. Drain ensures that all
messages that are inflight are processed before canceling the subscription.
Connections can also be drained as well. Draining a connection closes it, after
all subscriptions have been drained and all outbound messages have been sent to
the server.

```typescript
// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// to create a connection to a nats-server:
const nc = await connect({ servers: "demo.nats.io:4222" });

// create a simple subscriber and iterate over messages
// matching the subscription
const sub = nc.subscribe("hello");
(async () => {
  for await (const m of sub) {
    console.log(`[${sub.getProcessed()}]: ${m.string()}`);
  }
  console.log("subscription closed");
})();

nc.publish("hello", "world");
nc.publish("hello", "again");

// we want to ensure that messages that are in flight
// get processed, so we are going to drain the
// connection. Drain is the same as close, but makes
// sure that all messages in flight get seen
// by the iterator. After calling drain,
// the connection closes.
await nc.drain();
```

```typescript
interface Person {
  name: string;
}

// create a simple subscriber and iterate over messages
// matching the subscription
const sub = nc.subscribe("people");
(async () => {
  for await (const m of sub) {
    // typescript will see this as a Person
    const p = m.json<Person>();
    console.log(`[${sub.getProcessed()}]: ${p.name}`);
  }
})();

const p = { name: "Memo" } as Person;
nc.publish("people", JSON.stringify(p));
```

### Wildcard Subscriptions

Subjects can be used to organize messages into hierarchies. For example, a
subject may contain additional information that can be useful in providing a
context to the message, such as the ID of the client that sent the message, or
the region where a message originated.

Instead of subscribing to each specific subject, you can create subscriptions
that have subjects with wildcards. Wildcards match one or more tokens in a
subject. A token is a string following a period (`.`).

All subscriptions are independent. If two different subscriptions match a
subject, both will get to process the message:

```typescript
import { connect } from "@nats-io/transport-deno";
import type { Subscription } from "@nats-io/transport-deno";
const nc = await connect({ servers: "demo.nats.io:4222" });

// subscriptions can have wildcard subjects
// the '*' matches any string in the specified token position
const s1 = nc.subscribe("help.*.system");
const s2 = nc.subscribe("help.me.*");
// the '>' matches any tokens in that position or following
// '>' can only be specified at the end
const s3 = nc.subscribe("help.>");

async function printMsgs(s: Subscription) {
  const subj = s.getSubject();
  console.log(`listening for ${subj}`);
  const c = 13 - subj.length;
  const pad = "".padEnd(c);
  for await (const m of s) {
    console.log(
      `[${subj}]${pad} #${s.getProcessed()} - ${m.subject} ${
        m.data ? " " + m.string() : ""
      }`,
    );
  }
}

printMsgs(s1);
printMsgs(s2);
printMsgs(s3);

// don't exit until the client closes
await nc.closed();
```

### Services: Request/Reply

Request/Reply is NATS equivalent to an HTTP request. To make requests you
publish messages as you did before, but also specify a `reply` subject. The
`reply` subject is where a service will publish (send) your response.

NATS provides syntactic sugar, for publishing requests. The `request()` API will
generate a reply subject and manage the creation of a subscription under the
covers to receive the reply. It will also start a timer to ensure that if a
response is not received within your specified time, the request fails. The
example also illustrates a graceful shutdown.

#### Services

Here's an example of a service. It is a bit more complicated than expected
simply to illustrate not only how to create responses, but how the subject
itself is used to dispatch different behaviors.

```typescript
import { connect, Subscription } from "@nats-io/nats-deno";

// create a connection
const nc = await connect({ servers: "demo.nats.io" });

// this subscription listens for `time` requests and returns the current time
const sub = nc.subscribe("time");
(async (sub: Subscription) => {
  console.log(`listening for ${sub.getSubject()} requests...`);
  for await (const m of sub) {
    if (m.respond(new Date().toISOString())) {
      console.info(`[time] handled #${sub.getProcessed()}`);
    } else {
      console.log(`[time] #${sub.getProcessed()} ignored - no reply subject`);
    }
  }
  console.log(`subscription ${sub.getSubject()} drained.`);
})(sub);

// this subscription listens for admin.uptime and admin.stop
// requests to admin.uptime returns how long the service has been running
// requests to admin.stop gracefully stop the client by draining
// the connection
const started = Date.now();
const msub = nc.subscribe("admin.*");
(async (sub: Subscription) => {
  console.log(`listening for ${sub.getSubject()} requests [uptime | stop]`);
  // it would be very good to verify the origin of the request
  // before implementing something that allows your service to be managed.
  // NATS can limit which client can send or receive on what subjects.
  for await (const m of sub) {
    const chunks = m.subject.split(".");
    console.info(`[admin] #${sub.getProcessed()} handling ${chunks[1]}`);
    switch (chunks[1]) {
      case "uptime":
        // send the number of millis since up
        m.respond(`${Date.now() - started}`);
        break;
      case "stop": {
        m.respond(`[admin] #${sub.getProcessed()} stopping....`);
        // gracefully shutdown
        nc.drain()
          .catch((err) => {
            console.log("error draining", err);
          });
        break;
      }
      default:
        console.log(
          `[admin] #${sub.getProcessed()} ignoring request for ${m.subject}`,
        );
    }
  }
  console.log(`subscription ${sub.getSubject()} drained.`);
})(msub);

// wait for the client to close here.
await nc.closed().then((err?: void | Error) => {
  let m = `connection to ${nc.getServer()} closed`;
  if (err) {
    m = `${m} with an error: ${err.message}`;
  }
  console.log(m);
});
```

#### Making Requests

Here's a simple example of a client making a simple request from the service
above:

```typescript
import { connect, Empty } from "../../src/types.ts";

// create a connection
const nc = await connect({ servers: "demo.nats.io:4222" });

// the client makes a request and receives a promise for a message
// by default the request times out after 1s (1000 millis) and has
// no payload.
await nc.request("time", Empty, { timeout: 1000 })
  .then((m) => {
    console.log(`got response: ${m.string()}`);
  })
  .catch((err) => {
    console.log(`problem with request: ${err.message}`);
  });

await nc.close();
```

Of course you can also use a tool like the nats cli:

```bash
> nats -s demo.nats.io req time ""
11:39:59 Sending request on "time"
11:39:59 Received with rtt 97.814458ms
2024-06-26T16:39:59.710Z

> nats -s demo.nats.io req admin.uptime ""
11:38:41 Sending request on "admin.uptime"
11:38:41 Received with rtt 99.065458ms
61688

>nats -s demo.nats.io req admin.stop ""
11:39:08 Sending request on "admin.stop"
11:39:08 Received with rtt 100.004959ms
[admin] #5 stopping....
```

### Queue Groups

Queue groups allow scaling of services horizontally. Subscriptions for members
of a queue group are treated as a single service. When you send a message to a
queue group subscription, only a single client in a queue group will receive it.

There can be any number of queue groups. Each group is treated as its own
independent unit. Note that non-queue subscriptions are also independent of
subscriptions in a queue group.

```typescript
import { connect } from "@nats-io/transport-deno";
import type { NatsConnection, Subscription } from "@nats-io/transport-deno";

async function createService(
  name: string,
  count = 1,
  queue = "",
): Promise<NatsConnection[]> {
  const conns: NatsConnection[] = [];
  for (let i = 1; i <= count; i++) {
    const n = queue ? `${name}-${i}` : name;
    const nc = await connect(
      { servers: "demo.nats.io:4222", name: `${n}` },
    );
    nc.closed()
      .then((err) => {
        if (err) {
          console.error(
            `service ${n} exited because of error: ${err.message}`,
          );
        }
      });
    // create a subscription - note the option for a queue, if set
    // any client with the same queue will be the queue group.
    const sub = nc.subscribe("echo", { queue: queue });
    const _ = handleRequest(n, sub);
    console.log(`${n} is listening for 'echo' requests...`);
    conns.push(nc);
  }
  return conns;
}

// simple handler for service requests
async function handleRequest(name: string, s: Subscription) {
  const p = 12 - name.length;
  const pad = "".padEnd(p);
  for await (const m of s) {
    // respond returns true if the message had a reply subject, thus it could respond
    if (m.respond(m.data)) {
      console.log(
        `[${name}]:${pad} #${s.getProcessed()} echoed ${m.string()}`,
      );
    } else {
      console.log(
        `[${name}]:${pad} #${s.getProcessed()} ignoring request - no reply subject`,
      );
    }
  }
}

// let's create two queue groups and a standalone subscriber
const conns: NatsConnection[] = [];
conns.push(...await createService("echo", 3, "echo"));
conns.push(...await createService("other-echo", 2, "other-echo"));
conns.push(...await createService("standalone"));

const a: Promise<void | Error>[] = [];
conns.forEach((c) => {
  a.push(c.closed());
});
await Promise.all(a);
```

Run it and publish a request to the subject `echo` to see what happens.

## Advanced Usage

### Headers

NATS headers are similar to HTTP headers. Headers are enabled automatically if
the server supports them. Note that if you publish a message using headers but
the server doesn't support them, an Error is thrown. Also note that even if you
are publishing a message with a header, it is possible for the recipient to not
support them.

```typescript
import { connect, createInbox, Empty, headers } from "../../src/types.ts";
import { nuid } from "../../nats-base-client/nuid.ts";

const nc = await connect(
  {
    servers: `demo.nats.io`,
  },
);

const subj = createInbox();
const sub = nc.subscribe(subj);
(async () => {
  for await (const m of sub) {
    if (m.headers) {
      for (const [key, value] of m.headers) {
        console.log(`${key}=${value}`);
      }
      // reading a header is not case sensitive
      console.log("id", m.headers.get("id"));
    }
  }
})().then();

// header names can be any printable ASCII character with the  exception of `:`.
// header values can be any ASCII character except `\r` or `\n`.
// see https://www.ietf.org/rfc/rfc822.txt
const h = headers();
h.append("id", nuid.next());
h.append("unix_time", Date.now().toString());
nc.publish(subj, Empty, { headers: h });

await nc.flush();
await nc.close();
```

### No Responders

Requests can fail for many reasons. A common reason for a failure is the lack of
interest in the subject. Typically these surface as a timeout error. If the
server is enabled to use headers, it will also enable a `no responders` feature.
If you send a request for which there's no interest, the request will be
immediately rejected:

```typescript
import { connect } from "@nats-io/transport-deno";
import {
  NoRespondersError,
  RequestError,
  TimeoutError,
} from "@nats-io/transport-deno";

const nc = await connect({
  servers: `demo.nats.io`,
});

try {
  const m = await nc.request("hello.world");
  console.log(m.data);
} catch (err) {
  if (err instanceof RequestError) {
    if (err.cause instanceof TimeoutError) {
      console.log("someone is listening but didn't respond");
    } else if (err.cause instanceof NoRespondersError) {
      console.log("no one is listening to 'hello.world'");
    } else {
      console.log(
        `failed due to unknown error: ${(err.cause as Error)?.message}`,
      );
    }
  } else {
    console.log(`request failed: ${(err as Error).message}`);
  }
}

await nc.close();
```

### Authentication

NATS supports many different forms of credentials:

- username/password
- token
- NKEYS
- client certificates
- JWTs

For user/password and token authentication, you can simply provide them as
`ConnectionOptions` - see `user`, `pass`, `token`. Internally these mechanisms
are implemented as an `Authenticator`. An `Authenticator` is simply a function
that handles the type of authentication specified.

Setting the `user`/`pass` or `token` options, simply initializes an
`Authenticator` and sets the username/password.

```typescript
// if the connection requires authentication, provide `user` and `pass` or
// `token` options in the NatsConnectionOptions
import { connect } from "@nats-io/transport-deno";

const nc1 = await connect({
  servers: "127.0.0.1:4222",
  user: "jenny",
  pass: "867-5309",
});
const nc2 = await connect({ port: 4222, token: "t0pS3cret!" });
```

#### Authenticators

NKEYs and JWT authentication are more complex, as they cryptographically respond
to a server challenge.

Because NKEY and JWT authentication may require reading data from a file or an
HTTP cookie, these forms of authentication will require a bit more from the
developer to activate them. The work is related to accessing these resources
varies depending on the platform.

After the credential artifacts are read, you can use one of these functions to
create the authenticator. You then simply assign it to the `authenticator`
property of the `ConnectionOptions`:

- `nkeyAuthenticator(seed?: Uint8Array | (() => Uint8Array)): Authenticator`
- `jwtAuthenticator(jwt: string | (() => string), seed?: Uint8Array | (()=> Uint8Array)): Authenticator`
- `credsAuthenticator(creds: Uint8Array | (() => Uint8Array)): Authenticator`

Note that the authenticators provide the ability to specify functions that
return the desired value. This enables dynamic environments such as a browser
where values accessed by fetching a value from a cookie.

Here's an example:

```javascript
// read the creds file as necessary, in the case it
// is part of the code for illustration purposes (this a partial creds)
const creds = `-----BEGIN NATS USER JWT-----
    eyJ0eXAiOiJqdSDJB....
  ------END NATS USER JWT------

************************* IMPORTANT *************************
  NKEY Seed printed below can be used sign and prove identity.
  NKEYs are sensitive and should be treated as secrets.

  -----BEGIN USER NKEY SEED-----
    SUAIBDPBAUTW....
  ------END USER NKEY SEED------
`;

const nc = await connect(
  {
    port: 4222,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
  },
);
```

### Flush

Flush sends a `PING` protocol message to the server. When the server responds
with `PONG` you are guaranteed that all pending data was sent and received by
the server. Note `ping()` effectively adds a server round-trip. All NATS clients
handle their buffering optimally, so `ping(): Promise<void>` shouldn't be used
except in cases where you are writing some sort of test, as you may be degrading
the performance of the client.

```javascript
nc.publish("foo");
nc.publish("bar");
await nc.flush();
```

### `PublishOptions`

When you publish a message you can specify some options:

- `reply` - this is a subject to receive a reply (you must set up a subscription
  on the reply subject) before you publish.
- `headers` - a set of headers to decorate the message.

### `SubscriptionOptions`

You can specify several options when creating a subscription:

- `max`: maximum number of messages to receive - auto unsubscribe
- `timeout`: how long to wait for the first message
- `queue`: the [queue group](#queue-groups) name the subscriber belongs to
- `callback`: a function with the signature
  `(err: Error|null, msg: Msg) => void;` that should be used for handling the
  message. Subscriptions with callbacks are NOT iterators.

#### Auto Unsubscribe

```javascript
// subscriptions can auto unsubscribe after a certain number of messages
nc.subscribe("foo", { max: 10 });
```

#### Timeout Subscriptions

```javascript
// create subscription with a timeout, if no message arrives
// within the timeout, the subscription throws a timeout error
const sub = nc.subscribe("hello", { timeout: 1000 });
(async () => {
  for await (const _m of sub) {
    // handle the messages
  }
})().catch((err) => {
  if (err instanceof TimeoutError) {
    console.log(`sub timed out!`);
  } else {
    console.log(`sub iterator got an error!`);
  }
  nc.close();
});
```

### `RequestOptions`

When making a request, there are several options you can pass:

- `timeout`: how long to wait for the response
- `headers`: optional headers to include with the message
- `noMux`: create a new subscription to handle the request. Normally a shared
  subscription is used to receive response messages.
- `reply`: optional subject where the reply should be sent.

#### `noMux` and `reply`

Under the hood, the request API simply uses a wildcard subscription to handle
all requests you send.

In some cases, the default subscription strategy doesn't work correctly. For
example, a client may be constrained by the subjects where it can receive
replies.

When `noMux` is set to `true`, the client will create a normal subscription for
receiving the response to a generated inbox subject before the request is
published. The `reply` option can be used to override the generated inbox
subject with an application provided one. Note that setting `reply` requires
`noMux` to be `true`:

```typescript
const m = await nc.request(
  "q",
  Empty,
  { reply: "bar", noMux: true, timeout: 1000 },
);
```

### Draining Connections and Subscriptions

Draining provides for a graceful way to unsubscribe or close a connection
without losing messages that have already been dispatched to the client.

You can drain a subscription or all subscriptions in a connection.

When you drain a subscription, the client sends an `unsubscribe` protocol
message to the server followed by a `flush`. The subscription handler is only
removed after the server responds. Thus all pending messages for the
subscription have been processed.

Draining a connection, drains all subscriptions. However when you drain the
connection it becomes impossible to make new subscriptions or send new requests.
After the last subscription is drained it also becomes impossible to publish a
message. These restrictions do not exist when just draining a subscription.

### Lifecycle and Informational Events

Clients can get notification on various event types by calling
`status(): AsyncIterable<Status>` on the connection, the currently included
status `type`s include:

- `disconnect` - the client disconnected from the specified `server`
- `reconnect` - the client reconnected to the specified `server`
- `reconnecting` - the client is in its reconnect loop
- `update` - the cluster configuration has been updated, if servers were added
  the `added` list will specify them, if servers were deleted servers the
  `deleted` list will specify them.
- `ldm` - the server has started its lame duck mode and will evict clients
- `error` - an async error (such as a permission violation) was received, the
  error is specified in the `error` property. Note that permission errors for
  subscriptions are also notified to the subscription.
- `ping` - the server has not received a response for client pings, the number
  of outstanding pings are notified in the `pendingPings` property. Note that
  this should onlyl be `1` under normal operations.
- `staleConnection` - the connection is stale (client will reconnect)
- `forceReconnect` - the client has been instructed to reconnect because of
  user-code (`reconnect()`)
- `close` - the client has closed, no further reconnects will be attempted.

```javascript
const nc = await connect(opts);
(async () => {
  console.info(`connected ${nc.getServer()}`);
  for await (const s of nc.status()) {
    switch (s.type) {
      case "disconnect":
      case "reconnect":
        console.log(s);
        break;
      default:
        // ignored
    }
  }
})().then();

nc.closed()
  .then((err) => {
    console.log(
      `connection closed ${err ? " with error: " + err.message : ""}`,
    );
  });
```

Be aware that when a client closes, you will need to wait for the `closed()`
promise to resolve. When it resolves, the client is done and will not reconnect.

### Async vs. Callbacks

Previous versions of the JavaScript NATS clients specified callbacks for message
processing. This required complex handling logic when a service required
coordination of operations. Callbacks are an inversion of control anti-pattern.

The async APIs trivialize complex coordination and makes your code easier to
maintain. With that said, there are some implications:

- Async subscriptions buffer inbound messages.
- Subscription processing delays until the runtime executes the promise related
  microtasks at the end of an event loop.

In a traditional callback-based library, I/O happens after all data yielded by a
read in the current event loop completes processing. This means that callbacks
are invoked as part of processing. With async, the processing is queued in a
microtask queue. At the end of the event loop, the runtime processes the
microtasks, which in turn resumes your functions. As expected, this increases
latency, but also provides additional liveliness.

To reduce async latency, the NATS client allows processing a subscription in the
same event loop that dispatched the message. Simply specify a `callback` in the
subscription options. The signature for a callback is
`(err: (NatsError|null), msg: Msg) => void`. When specified, the subscription
iterator will never yield a message, as the callback will intercept all
messages.

Note that `callback` likely shouldn't even be documented, as likely it is a
workaround to an underlying application problem where you should be considering
a different strategy to horizontally scale your application, or reduce pressure
on the clients, such as using queue workers, or more explicitly targeting
messages. With that said, there are many situations where using callbacks can be
more performant or appropriate.

## Connection Options

The following is the list of connection options and default values.

| Option                  | Default            | Description                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authenticator`         | none               | Specifies the authenticator function that sets the client credentials.                                                                                                                                                                                                                                                                                                                   |
| `debug`                 | `false`            | If `true`, the client prints protocol interactions to the console. Useful for debugging.                                                                                                                                                                                                                                                                                                 |
| `ignoreClusterUpdates`  | `false`            | If `true` the client will ignore any cluster updates provided by the server.                                                                                                                                                                                                                                                                                                             |
| `ignoreAuthErrorAbort`  | `false`            | Prevents client connection aborts if the client fails more than twice in a row with an authentication error                                                                                                                                                                                                                                                                              |
| `inboxPrefix`           | `"_INBOX"`         | Sets de prefix for automatically created inboxes - `createInbox(prefix)`                                                                                                                                                                                                                                                                                                                 |
| `maxPingOut`            | `2`                | Max number of pings the client will allow unanswered before raising a stale connection error.                                                                                                                                                                                                                                                                                            |
| `maxReconnectAttempts`  | `10`               | Sets the maximum number of reconnect attempts. The value of `-1` specifies no limit.                                                                                                                                                                                                                                                                                                     |
| `name`                  |                    | Optional client name - recommended to be set to a unique client name.                                                                                                                                                                                                                                                                                                                    |
| `noAsyncTraces`         | `false`            | When `true` the client will not add additional context to errors associated with request operations. Setting this option to `true` will greatly improve performance of request/reply and JetStream publishers.                                                                                                                                                                           |
| `noEcho`                | `false`            | Subscriptions receive messages published by the client. Requires server support (1.2.0). If set to true, and the server does not support the feature, an error with code `NO_ECHO_NOT_SUPPORTED` is emitted, and the connection is aborted. Note that it is possible for this error to be emitted on reconnect when the server reconnects to a server that does not support the feature. |
| `noRandomize`           | `false`            | If set, the order of user-specified servers is randomized.                                                                                                                                                                                                                                                                                                                               |
| `noResolve`             | none               | If true, client will not resolve host names.                                                                                                                                                                                                                                                                                                                                             |
| `pass`                  |                    | Sets the password for a connection.                                                                                                                                                                                                                                                                                                                                                      |
| `pedantic`              | `false`            | Turns on strict subject format checks.                                                                                                                                                                                                                                                                                                                                                   |
| `pingInterval`          | `120000`           | Number of milliseconds between client-sent pings.                                                                                                                                                                                                                                                                                                                                        |
| `port`                  | `4222`             | Port to connect to (only used if `servers` is not specified).                                                                                                                                                                                                                                                                                                                            |
| `reconnect`             | `true`             | If false, client will not attempt reconnecting.                                                                                                                                                                                                                                                                                                                                          |
| `reconnectDelayHandler` | Generated function | A function that returns the number of millis to wait before the next connection to a server it connected to `()=>number`.                                                                                                                                                                                                                                                                |
| `reconnectJitter`       | `100`              | Number of millis to randomize after `reconnectTimeWait`.                                                                                                                                                                                                                                                                                                                                 |
| `reconnectJitterTLS`    | `1000`             | Number of millis to randomize after `reconnectTimeWait` when TLS options are specified.                                                                                                                                                                                                                                                                                                  |
| `reconnectTimeWait`     | `2000`             | If disconnected, the client will wait the specified number of milliseconds between reconnect attempts.                                                                                                                                                                                                                                                                                   |
| `servers`               | `"localhost:4222"` | String or Array of hostport for servers.                                                                                                                                                                                                                                                                                                                                                 |
| `timeout`               | 20000              | Number of milliseconds the client will wait for a connection to be established. If it fails it will emit a `connection_timeout` event with a NatsError that provides the hostport of the server where the connection was attempted.                                                                                                                                                      |
| `tls`                   | TlsOptions         | A configuration object for requiring a TLS connection (not applicable to nats.ws).                                                                                                                                                                                                                                                                                                       |
| `token`                 |                    | Sets a authorization token for a connection.                                                                                                                                                                                                                                                                                                                                             |
| `user`                  |                    | Sets the username for a connection.                                                                                                                                                                                                                                                                                                                                                      |
| `verbose`               | `false`            | Turns on `+OK` protocol acknowledgements.                                                                                                                                                                                                                                                                                                                                                |
| `waitOnFirstConnect`    | `false`            | If `true` the client will fall back to a reconnect mode if it fails its first connection attempt.                                                                                                                                                                                                                                                                                        |

### TlsOptions

| Option           | Default | Description                                                                                                                     |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ca`             | N/A     | CA certificate                                                                                                                  |
| `caFile`         |         | CA certificate filepath                                                                                                         |
| `cert`           | N/A     | Client certificate                                                                                                              |
| `certFile`       | N/A     | Client certificate file path                                                                                                    |
| `key`            | N/A     | Client key                                                                                                                      |
| `keyFile`        | N/A     | Client key file path                                                                                                            |
| `handshakeFirst` | false   | Connects to the server directly as TLS rather than upgrade the connection. Note that the server must be configured accordingly. |

In some Node and Deno clients, having the option set to an empty option,
requires the client have a secured connection.

### Jitter

The settings `reconnectTimeWait`, `reconnectJitter`, `reconnectJitterTLS`,
`reconnectDelayHandler` are all related. They control how long before the NATS
client attempts to reconnect to a server it has previously connected.

The intention of the settings is to spread out the number of clients attempting
to reconnect to a server over a period of time, and thus preventing a
["Thundering Herd"](https://docs.nats.io/developing-with-nats/reconnect/random).

The relationship between these is:

- If `reconnectDelayHandler` is specified, the client will wait the value
  returned by this function. No other value will be taken into account.
- If the client specified TLS options, the client will generate a number between
  0 and `reconnectJitterTLS` and add it to `reconnectTimeWait`.
- If the client didn't specify TLS options, the client will generate a number
  between 0 and `reconnectJitter` and add it to `reconnectTimeWait`.
