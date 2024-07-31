/*
 * Copyright 2022-2023 The NATS Authors
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

import { connect } from "jsr:@nats-io/nats-transport-deno@3.0.0-5";

import type { QueuedIterator } from "jsr:@nats-io/nats-transport-deno@3.0.0-5";

import {
  ServiceError,
  ServiceErrorCodeHeader,
  ServiceErrorHeader,
  Svc,
} from "../src/mod.ts";
import type { ServiceMsg, ServiceStats } from "../src/mod.ts";
import { assertEquals } from "jsr:@std/assert";

// connect to NATS on demo.nats.io
const nc = await connect({ servers: ["demo.nats.io"] });

// All services have some basic stats that are collected like the
// number of requests processed, etc. Your service can accumulate
// other stats, and aggregate them to the stats report that you
// can retrieve via the monitoring stats() api.
// In this example, the service keeps track of the largest number
// it has seen and defines a custom statsHandler that aggregates
// it to the standard report
let maxMax = 0;
const statsHandler = (): Promise<unknown> => {
  return Promise.resolve({ max: maxMax });
};

// create a service - using the statsHandler
const svc = new Svc(nc);
const service = await svc.add({
  name: "max",
  version: "0.0.1",
  description: "returns max number in a request",
  statsHandler,
});

// add an endpoint listening on "max"
const max = service.addEndpoint("max");

// a service has the `stopped` property - which is a promise that
// resolves to null or an error (not rejects). This promise resolves
// whenever the service stops, so you can use a handler like this
// to activate some logic such as logging the service stopping
// when that happens.
service.stopped.then((err: Error | null) => {
  console.log(`service stopped ${err ? "because: " + err.message : ""}`);
});

// starting the service as an async function so that
// we can have this example be in a single file
(async () => {
  for await (const r of max) {
    // most of the logic is about validating the input
    // and returning an error to the client if the input
    // is not what we expect.
    decoder(r)
      .then((a) => {
        // we were able to parse an array of numbers from the request
        // with at least one entry, we sort in reverse order
        a.sort((a, b) => b - a);
        // and first entry has the largest number
        const max = a[0];
        // since our service also tracks the largest number ever seen
        // we update our largest number
        maxMax = Math.max(maxMax, max);
        console.log(
          `${service.info().name} calculated a response of ${max} from ${a.length} values`,
        );
        // finally we respond with a JSON number payload with the maximum value
        r.respond(JSON.stringify(max));
      })
      .catch((err) => {
        // if we are here, the initial processing of the array failed
        // the message presented to the service is wrapped as a "ServiceMsg"
        // which adds a simple way to represent errors to your clients
        console.log(`${service.info().name} got a bad request: ${err.message}`);
        // respondError sets the `Nats-Service-Error-Code` and `Nats-Service-Error`
        // headers on the message. This allows a client to check if the response
        // is an error
        r.respondError(
          (err as ServiceError).code || 400,
          err.message,
          JSON.stringify(0),
        );
      });
  }
})();

// decoder extracts a JSON payload and expects it to be an array of numbers
function decoder(r: ServiceMsg): Promise<number[]> {
  try {
    // decode JSON
    const a = r.json();
    // if not an array, this is bad input
    if (!Array.isArray(a)) {
      return Promise.reject(
        new ServiceError(400, "input must be an array"),
      );
    }
    // if we don't have at least one number, this is bad input
    if (a.length < 1) {
      return Promise.reject(
        new ServiceError(400, "input must have more than one element"),
      );
    }
    // if we find an entry in the array that is not a number, we have bad input
    const bad = a.find((e) => {
      return typeof e !== "number";
    });
    if (bad) {
      return Promise.reject(
        new ServiceError(400, "input contains invalid types"),
      );
    }
    // otherwise we are good
    return Promise.resolve(a);
  } catch (err) {
    // this is JSON.parse() - in JSONCodec failing to parse JSON
    return Promise.reject(new ServiceError(400, err.message));
  }
}

// Now we switch gears and look at a client making a request:

// we call the service without any payload and expect some errors
await nc.request("max").then((r) => {
  // errors are really these two headers set on the message
  assertEquals(r.headers?.get(ServiceErrorHeader), "Bad JSON");
  assertEquals(r.headers?.get(ServiceErrorCodeHeader), "400");
});
// call it with an empty array also expecting an error response
await nc.request("max", JSON.stringify([])).then((r) => {
  // Here's an alternative way of checking if the response is an error response
  assertEquals(ServiceError.isServiceError(r), true);
  const se = ServiceError.toServiceError(r);
  assertEquals(se?.message, "input must have more than one element");
  assertEquals(se?.code, 400);
});

// call it with valid arguments
await nc.request("max", JSON.stringify([1, 10, 100])).then((r) => {
  // no error headers
  assertEquals(ServiceError.isServiceError(r), false);
  // and the response is on the payload, so we process the JSON we
  // got from the service
  assertEquals(r.json<number>(), 100);
});

// Monitoring
// The monitoring APIs return a promise, so that the client can start
// processing responses as they come in

// collect() simply waits for the iterator to stop (when we think we have
// all the responses)
async function collect<T>(p: Promise<QueuedIterator<T>>): Promise<T[]> {
  const iter = await p;
  const buf: T[] = [];
  for await (const v of iter) {
    buf.push(v);
  }
  return buf;
}

const m = svc.client();
// discover
const found = await collect(m.ping());
assertEquals(found.length, 1);
assertEquals(found[0].name, "max");
// get stats
await collect(m.stats("max", found[0].id));

// The monitoring API is made using specific subjects
// We can do standard request reply, however that will return
// only the first response we get - if you have multiple services
// the first one that responded wins. In this particular case
// we are only expecting a single response because the request is
// addressed to a specific service instance.

// All monitoring subjects have the format:
// $SRV.<VERB>.<name>.<id>
// where the verb can be 'PING', 'INFO', or 'STATS'
// the name is optional but matches a service name.
// The id is also optional, but you must know it (from ping or one of
// other requests that allowed you to discover the service) to
// target the service specifically as we do here:
const r = await nc.request(`$SRV.STATS.max.${found[0].id}`);
const stats = r.json<ServiceStats>();

assertEquals(stats.name, "max");
assertEquals(stats.endpoints?.[0].num_requests, 3);
assertEquals((stats.endpoints?.[0].data as { max: number }).max, 100);

// stop the service
await service.stop();
// and close the connection
await nc.close();
