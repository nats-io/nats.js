# Services

The Services module introduces a higher-level API for implementing services with
NATS. NATS has always been a strong technology on which to build services, as
they are easy to write, are location and DNS independent and can be scaled up or
down by simply adding or removing instances of the service.

The services module further streamlines NATS services development by providing
observability and standardization. The Service Framework allows your services to
be discovered, queried for status and schema information without additional
work.

To create services using the services module simply install this library and
create a `new Svc(nc)`.

## Creating a Service

```typescript
const svc = new Svc(nc);
const service = await svc.add({
  name: "max",
  version: "0.0.1",
  description: "returns max number in a request",
});

// add an endpoint listening on "max"
const max = service.addEndpoint("max", (err, msg) => {
  msg?.respond();
});
```

If you omit the handler, the service is actually an iterator for service
messages. To process messages incoming to the service:

```typescript
for await (const r of max) {
  r.respond();
}
```

For those paying attention, this looks suspiciously like a regular subscription.
And it is. The only difference is that the service collects additional
_metadata_ that allows the service framework to provide some monitoring and
discovery for free.

To invoke the service, it is a simple NATS request:

```typescript
const response = await nc.request("max", JSONCodec().encode([1, 2, 3]));
```

## Discovery and Monitoring

When the service started, the framework automatically assigned it an unique
`ID`. The `name` and `ID` identify particular instance of the service. If you
start a second instance, that instance will also have the same `name` but will
sport a different `ID`.

To discover services that are running, create a monitoring client:

```typescript
const m = svc.client();

// you can ping, request info, and stats information.
// All the operations return iterators describing the services found.
for await (const s of await m.ping()) {
  console.log(s.id);
}
await m.stats();
await m.info();
```

Additional filtering is possible, and they are valid for all the operations:

```typescript
// get the stats services that have the name "max"
await m.stats("max");
// or target a specific instance:
await m.stats("max", id);
```

For a more elaborate first example see:
[simple example here](examples/01_services.ts)

## Multiple Endpoints

More complex services will have more than one endpoint. For example a calculator
service may have endpoints for `sum`, `average`, `max`, etc. This type of
service is also possible with the service api.

You can create the service much like before. In this case, you don't need the
endpoint (yet!):

```typescript
const calc = await nc.services.add({
  name: "calc",
  version: "0.0.1",
  description: "example calculator service",
});
```

One of the simplifications for service it that it helps build consistent subject
hierarchy for your services. To create a subject hierarchy, you add a _group_.

```typescript
const g = calc.addGroup("calc");
```

The group is a _prefix_ subject where you can add endpoints. The name can be
anything that is a valid subject prefix.

```typescript
const sums = g.addEndpoint("sum");
(async () => {
  for await (const m of sums) {
    // decode the message payload into an array of numbers
    const numbers = JSONCodec<number[]>().decode(m.data);
    // add them together
    const s = numbers.reduce((sum, v) => {
      return sum + v;
    });
    // return a number
    m.respond(JSONCodec().encode(s));
  }
})();
```

`addEndpoint()` takes a name, and an optional handler (it can also take a set of
options). The `name` must be a simple name. This means no dots, wildcards, etc.
`name` is then appended to the group where it is added, forming the subject
where the endpoint listens.

In the above case, the `sum` endpoint is listening for requests on `calc.sum`.

For those paying attention, you can specify a callback much like in the first
example, if you don't, the return value of the add endpoint is an iterator.

For a complete example see:
[multiple endpoints](examples/02_multiple_endpoints.ts)
