# JetStream

The jetstream module implements the JetStream protocol functionality for
JavaScript clients. JetStream is the NATS persistence engine providing
streaming, message, and worker queues with At-Least-Once semantics.

To use JetStream simply install this library, and create a `jetstream(nc)` or
`jetstreamManager(nc)` with a connection provided by your chosen transport
module. JetStreamManager allows you to interact with the NATS server to manage
JetStream resources. The JetStream client allows you to interact with JetStream
resources.

## Installation

Note that this library is distributed in two different registries:

- npm a node-specific library supporting CJS (`require`) and ESM (`import`)
- jsr a node and other ESM (`import`) compatible runtimes (deno, browser, node)

If your application doesn't use `require`, you can simply depend on the JSR
version.

### NPM

The NPM registry hosts a node-only compatible version of the library
[@nats-io/jetstream](https://www.npmjs.com/package/@nats-io/jetstream)
supporting both CJS and ESM:

```bash
npm install @nats-io/jetstream
```

### JSR

The JSR registry hosts the ESM-only
[@nats-io/jetstream](https://jsr.io/@nats-io/jetstream) version of the library.

```bash
deno add @nats-io/jetstream
```

```bash
npx jsr add @nats-io/jetstream
```

```bash
yarn dlx jsr add @nats-io/jetstream
```

```bash
bunx jsr add @nats-io/jetstream
```

## Referencing the library

Once you import the library, you can reference in your code as:

```javascript
import { jetstream, jetstreamManager } from "@nats-io/jetstream";

// or in node (only when using CJS)
const { jetstream, jetstreamManager } = require("@nats-io/jetstream");

// using a nats connection:
const js = jetstream(nc);
// and/or
const jsm = await jetstreamManager(nc);
```

# JetStream

JetStream is the NATS persistence engine providing streaming, message, and
worker queues with At-Least-Once semantics. JetStream stores messages in
_streams_. A stream defines how messages are stored and limits such as how long
they persist or how many to keep. To store a message in JetStream, you simply
need to publish to a subject that is associated with a stream.

Messages are replayed from a stream by _consumers_. A consumer configuration
specifies which messages should be presented. For example a consumer may only be
interested in viewing messages from a specific sequence or starting from a
specific time, or having a specific subject. The configuration also specifies if
the server should require messages to be acknowledged and how long to wait for
acknowledgements. The consumer configuration also specifies options to control
the rate at which messages are presented to the client.

For more information about JetStream, please visit the
[JetStream repo](https://github.com/nats-io/jetstream).

## Migration

If you were using an embedded version of JetStream as provided by the npm
nats@^2.0.0 or nats.deno or nats.ws libraries, you will have to import this
library and replace your usages of `NatsConnection#jetstream()` or
`NatsConnection#jetstreamManager()` with `jetstream(nc)` or
`await jetstreamManager(nc)` where you pass your actual connection to the above
functions.

Also note that if you are using [KV](../kv/README.md) or
[ObjectStore](../obj/README.md), these APIs are now provided by a different
libraries `@nats-io/kv` and `@nats-io/obj` respectively. If you are only using
KV or ObjectStore, there's no need to reference this library directly unless you
need to do some specific JetStreamManager API, as both `@nats-io/kv` and
`@nats-io/obj` depend on this library already and use it under the hood.

## JetStreamManager (JSM)

The JetStreamManager provides CRUD functionality to manage streams and consumers
resources. To access a JetStream manager:

```typescript
const jsm = await jetstreamManager(nc);

for await (const si of jsm.streams.list()) {
  console.log(si);
}

// add a stream - jetstream can capture nats core messages
const stream = "mystream";
const subj = `mystream.*`;
await jsm.streams.add({ name: stream, subjects: [subj] });

for (let i = 0; i < 100; i++) {
  nc.publish(`${subj}.a`, Empty);
}

// find a stream that stores a specific subject:
const name = await jsm.streams.find("mystream.A");

// retrieve info about the stream by its name
const si = await jsm.streams.info(name);

// update a stream configuration
si.config.subjects?.push("a.b");
await jsm.streams.update(si.config);

// get a particular stored message in the stream by sequence
// this is not associated with a consumer
const sm = await jsm.streams.getMessage(stream, { seq: 1 });
console.log(sm.seq);

// delete the 5th message in the stream, securely erasing it
await jsm.streams.deleteMessage(stream, 5);

// purge all messages in the stream, the stream itself remains.
await jsm.streams.purge(stream);

// purge all messages with a specific subject (filter can be a wildcard)
await jsm.streams.purge(stream, { filter: "a.b" });

// purge messages with a specific subject keeping some messages
await jsm.streams.purge(stream, { filter: "a.c", keep: 5 });

// purge all messages with upto (not including seq)
await jsm.streams.purge(stream, { seq: 90 });

// purge all messages with upto sequence that have a matching subject
await jsm.streams.purge(stream, { filter: "a.d", seq: 100 });

// list all consumers for a stream:
const consumers = await jsm.consumers.list(stream).next();
consumers.forEach((ci) => {
  console.log(ci);
});

// add a new durable consumer
await jsm.consumers.add(stream, {
  durable_name: "me",
  ack_policy: AckPolicy.Explicit,
});

// retrieve a consumer's status and configuration
const ci = await jsm.consumers.info(stream, "me");
console.log(ci);

// delete a particular consumer
await jsm.consumers.delete(stream, "me");
```

## JetStream Client

The JetStream client presents an API for adding messages to a stream or
processing messages stored in a stream.

```typescript
// create the stream
const jsm = await jetstreamManager(nc);
await jsm.streams.add({ name: "a", subjects: ["a.*"] });

// create a jetstream client:
const js = jetstream(nc);

// publish a message received by a stream
let pa = await js.publish("a.b");
// jetstream returns an acknowledgement with the
// stream that captured the message, it's assigned sequence
// and whether the message is a duplicate.
const stream = pa.stream;
const seq = pa.seq;
const duplicate = pa.duplicate;

// More interesting is the ability to prevent duplicates
// on messages that are stored in the server. If
// you assign a message ID, the server will keep looking
// for the same ID for a configured amount of time (within a
// configurable time window), and reject messages that
// have the same ID:
await js.publish("a.b", Empty, { msgID: "a" });

// you can also specify constraints that should be satisfied.
// For example, you can request the message to have as its
// last sequence before accepting the new message:
await js.publish("a.b", Empty, { expect: { lastMsgID: "a" } });
await js.publish("a.b", Empty, { expect: { lastSequence: 3 } });
// save the last sequence for this publish
pa = await js.publish("a.b", Empty, { expect: { streamName: "a" } });
// you can also mix the above combinations

// this stream here accepts wildcards, you can assert that the
// last message sequence recorded on a particular subject matches:
const buf: Promise<PubAck>[] = [];
for (let i = 0; i < 100; i++) {
  buf.push(js.publish("a.a", Empty));
}
await Promise.all(buf);
// if additional "a.b" has been recorded, this will fail
await js.publish("a.b", Empty, { expect: { lastSubjectSequence: pa.seq } });
```

### Processing Messages

The JetStream API provides different mechanisms for retrieving messages. Each
mechanism offers a different "buffering strategy" that provides advantages that
map to how your application works and processes messages.

#### Basics

To understand how these strategies differentiate, let's review some aspects of
processing a stream which will help you choose and design a strategy that works
for your application.

First and foremost, processing a stream is different from processing NATS core
messages:

In NATS core, you are presented with a message whenever a message is published
to a subject that you have subscribed to. When you process a stream you can
filter messages found on a stream to those matching subjects that interest you,
but the rate of delivery can be much higher, as the stream could store many more
messages that match your consumer than you would normally receive in a core NATS
subscription. When processing a stream, you can simulate the original rate at
which messages were ingested, but typically messages are processed "as fast as
possible". This means that a client could be overwhelmed by the number of
messages presented by the server.

In NATS core, if you want to ensure that your message was received as intended,
you publish a request. The receiving client can then respond an acknowledgement
or return some result. When processing a stream, the consumer configuration
dictates whether messages sent to the consumer should be acknowledged or not.
The server tracks acknowledged messages and knows which messages the consumer
has not seen or that may need to be resent due to a missing acknowledgement. By
default, clients have 30 seconds to respond or extend the acknowledgement. If a
message fails to be acknowledged in time, the server will resend the message
again. This functionality has a very important implications. Consumers should
not buffer more messages than they can process and acknowledge within the
acknowledgement window.

Lastly, the NATS server protects itself and when it detects that a client
connection is not draining data quickly enough, it disconnects it to prevent the
degradation from impacting other clients.

Given these competing conditions, the JetStream APIs allow a client to express
not only the buffering strategy for reading a stream at a pace the client can
sustain, but also how the reading happens.

JetStream allows the client to:

- Request the next message (one message at time)
- Request the next N messages
- Request and maintain a buffer of N messages

The first two options allow the client to control and manage its buffering
manually, when the client is done processing the messages, it can at its
discretion to request additional messages or not.

The last option auto buffers messages for the client controlling the message and
data rates. The client specifies how many messages it wants to receive, and as
it consumes them, the library requests additional messages in an effort to
prevent the consumer from stalling, and thus maximize performance.

#### Retrieving the Consumer

Before messages can be read from a stream, the consumer should have been created
using the JSM APIs as shown above. After the consumer exists, the client simply
retrieves it:

```typescript
const stream = "a";
const consumer = "a";

const js = jetstream(nc);

// retrieve an existing consumer
const c = await js.consumers.get(stream, consumer);

// getting an ordered consumer requires no name
// as the library will create it
const oc = await js.consumers.get(stream);
```

[full example](examples/01_consumers.ts)

With the consumer in hand, the client can start reading messages using whatever
API is appropriate for the application.

#### JsMsg

All messages are `JsMsg`s, a `JsMsg` is a wrapped `Msg` - it has all the
standard fields in a NATS `Msg`, a `JsMsg` and provides functionality for
inspecting metadata encoded into the message's reply subject. This metadata
includes:

- sequence (`seq`)
- `redelivered`
- full info via info which shows the delivery sequence, and how many messages
  are pending among other things.
- Multiple ways to acknowledge a message:
  - `ack()`
  - `nak(millis?)` - like ack, but tells the server you failed to process it,
    and it should be resent. If a number is specified, the message will be
    resent after the specified value. The additional argument only supported on
    server versions 2.7.1 or greater
  - `working()` - informs the server that you are still working on the message
    and thus prevent receiving the message again as a redelivery.
  - `term()` - specifies that you failed to process the message and instructs
    the server to not send it again (to any consumer).

#### Requesting a single message

The simplest mechanism to process messages is to request a single message. This
requires sending a request to the server. When no messages are available, the
request will return a `null` message. Since the client is explicitly requesting
the message, it is in full control of when to ask for another.

The request will reject if there's an exceptional condition, such as when the
underlying consumer or stream is deleted after retrieving the consumer instance,
or by a change to the clients subject permissions that prevent interactions with
JetStream, or JetStream is not available.

```typescript
const m = await c.next();
if (m) {
  console.log(m.subject);
  m.ack();
} else {
  console.log(`didn't get a message`);
}
```

[full example](examples/02_next.ts)

The operation takes an optional argument. Currently, the only option is an
`expires` option which specifies the maximum number of milliseconds to wait for
a message. This is defaulted to 30 seconds. Note this default is a good value
because it gives the opportunity to retrieve a message without excessively
polling the server (which could affect the server performance).

`next()` should be your go-to API when implementing services that process
messages or work queue streams, as it allows you to horizontally scale your
processing simply by starting and managing multiple processes.

Keep in mind that you can also simulate `next()` in a loop and have the library
provide an iterator by using `consume()`. That API be explained later in the
document.

#### Fetching batch of messages

You can request multiple messages at time. The request is a _long_ poll. So it
remains open and keep dispatching you messages until the desired number of
messages is received, or the `expires` time triggers. This means that the number
of messages you request is only a hint and it is just the upper bound on the
number of messages you will receive. By default `fetch()` will retrieve 100
messages in a batch, but you can control it as shown in this example:

```typescript
for (let i = 0; i < 3; i++) {
  let messages = await c.fetch({ max_messages: 4, expires: 2000 });
  for await (const m of messages) {
    m.ack();
  }
  console.log(`batch completed: ${messages.getProcessed()} msgs processed`);
}
```

[full example](examples/03_batch.ts)

Fetching batches is useful if you parallelize a number of requests to take
advantage of the asynchronous processing of data with a number of workers for
example. To get a new batch simply fetch again.

#### Consuming messages

In the previous two sections messages were retrieved manually by your
application, and allowed you to remain in control of whether you wanted to
receive one or more messages with a single request.

A third option automates the process of re-requesting more messages. The library
will monitor messages it yields, and request additional messages to maintain
your processing momentum. The operation will continue until you `break` or call
`stop()` the iterator.

The `consume()` operation maintains an internal buffer of messages that auto
refreshes whenever 50% of the initial buffer is consumed. This allows the client
to process messages in a loop forever.

```typescript
const messages = await c.consume();
for await (const m of messages) {
  console.log(m.seq);
  m.ack();
}
```

[full example](examples/04_consume.ts)

Note that it is possible to do an automatic version of `next()` by simply
setting the maximum number of messages to buffer to `1`:

```typescript
const messages = await c.consume({ max_messages: 1 });
for await (const m of messages) {
  console.log(m.seq);
  m.ack();
}
```

The API simply asks for one message, but as soon as that message is processed or
the request expires, another is requested.

#### Horizontally Scaling Consumers (Previously known as Queue Consumer)

Scaling processing in a consumer is simply calling `next()/fetch()/consume()` on
a shared consumer. When horizontally scaling limiting the number of buffered
messages will likely yield better results as requests will be mapped 1-1 with
the processes preventing some processes from booking more messages while others
are idle.

A more balanced approach is to simply use `next()` or
`consume({max_messages: 1})`. This makes it so that if you start or stop
processes you automatically scale your processing, and if there's a failure you
won't delay the redelivery of messages that were in flight but never processed
by the client.

#### Callbacks

The `consume()` API normally use iterators for processing. If you want to
specify a callback, you can:

```typescript
const c = await js.consumers.get(stream, consumer);
console.log("waiting for messages");
await c.consume({
  callback: (m) => {
    console.log(m.seq);
    m.ack();
  },
});
```

#### Iterators, Callbacks, and Concurrency

The `consume()` and `fetch()` APIs yield a `ConsumerMessages`. One thing to keep
in mind is that the iterator for processing messages will not yield a new
message until the body of the loop completes.

Compare:

```typescript
const msgs = await c.consume();
for await (const m of msgs) {
  try {
    // this is simplest but could also create a head-of-line blocking
    // as no other message on the current buffer will be processed until
    // this iteration completes
    await asyncFn(m);
    m.ack();
  } catch (err) {
    m.nack();
  }
}
```

With

```typescript
const msgs = await c.consume();
for await (const m of msgs) {
  // this potentially has the problem of generating a very large number
  // of async operations which may exceed the limits of the runtime
  asyncFn(m)
    .then(() => {
      m.ack();
    })
    .catch((err) => {
      m.nack();
    });
}
```

In the first scenario, the processing is sequential. The second scenario is
concurrent.

Both of these behaviors are standard JavaScript, but you can use this to your
advantage. You can improve latency by not awaiting, but that will require a more
complex handling as you'll need to restrict and limit how many concurrent
operations you create and thus avoid hitting limits in your runtime.

One possible strategy is to use `fetch()`, and process asynchronously without
awaiting as you process message you'll need to implement accounting to track
when you should re-fetch, but a far simpler solution is to use `next()`, process
asynchronously and scale by horizontally managing processes instead.

Here's a solution that introduces a rate limiter:

```typescript
const messages = await c.consume({ max_messages: 10 });

// this rate limiter is just example code, do not use in production
const rl = new SimpleMutex(5);

async function schedule(m: JsMsg): Promise<void> {
  // pretend to do work
  await delay(1000);
  m.ack();
  console.log(`${m.seq}`);
}

for await (const m of messages) {
  // block reading messages until we have capacity
  await rl.lock();
  schedule(m)
    .catch((err) => {
      console.log(`failed processing: ${err.message}`);
      m.nak();
    })
    .finally(() => {
      // unblock, allowing a lock to resolve
      rl.unlock();
    });
}
```

[full example](examples/07_consume_jobs.ts)

#### Processing a Stream

Here's a contrived example on how a process examines a stream. Once all the
messages in the stream are processed the consumer is deleted.

Our processing is simply creating a frequency table of the second token in the
subject, printing the results after it is done.

```typescript
const messages = await c.consume();

const data = new Map<string, number>();
for await (const m of messages) {
  const chunks = m.subject.split(".");
  const v = data.get(chunks[1]) || 0;
  data.set(chunks[1], v + 1);
  m.ack();

  // if no pending, then we have processed the stream
  // and we can break
  if (m.info.pending === 0) {
    break;
  }
}

// we can safely delete the consumer
await c.delete();

// and print results
const keys = [];
for (const k of data.keys()) {
  keys.push(k);
}
keys.sort();
keys.forEach((k) => {
  console.log(`${k}: ${data.get(k)}`);
});
```

[full example](examples/08_consume_process.ts)

### Heartbeats

Since JetStream is available through NATS it is possible for your network
connection to not be directly connected to the JetStream server providing you
with messages. In those cases, it is possible for a JetStream server to go away,
and for the client to not notice it. This would mean your client would sit idle
thinking there are no messages, when in reality the JetStream service may have
restarted elsewhere.

For most issues, the client will auto-recover, but if it doesn't, and it starts
reporting `HeartbeatsMissed` statuses, you will want to `stop()` the
`ConsumerMessages`, and recreate it. Note that in the example below this is done
in a loop for example purposes:

```typescript
while (true) {
  const messages = await c.consume({ max_messages: 1 });

  // watch the to see if the consume operation misses heartbeats
  (async () => {
    for await (const s of await messages.status()) {
      if (s.type === ConsumerEvents.HeartbeatsMissed) {
        // you can decide how many heartbeats you are willing to miss
        const n = s.data as number;
        console.log(`${n} heartbeats missed`);
        if (n === 2) {
          // by calling `stop()` the message processing loop ends
          // in this case this is wrapped by a loop, so it attempts
          // to re-setup the consume
          messages.stop();
        }
      }
    }
  })();
  for await (const m of messages) {
    console.log(`${m.seq} ${m?.subject}`);
    m.ack();
  }
}
```

[full example](examples/06_heartbeats.ts)

Note that while the heartbeat interval is configurable, you shouldn't change it.

#### JetStream Ordered Consumers

An Ordered Consumer is a specialized consumer that ensures that messages are
presented in the correct order. If a message is out of order, the consumer is
recreated at the expected sequence.

The underlying consumer is created, managed and destroyed under the covers, so
you only have to specify the stream and possible startup options, or filtering:

```typescript
// note the name of the consumer is not specified
const a = await js.consumers.get(name);
const b = await js.consumers.get(name, { filterSubjects: [`${name}.a`] });
```

Note that uses of the consumer API for reading messages are checked for
concurrency preventing the ordered consumer from having operations initiated
with `fetch()` and `consume()` or `next()` while another is active.
