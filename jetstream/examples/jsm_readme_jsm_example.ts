/*
 * Copyright 2024 Synadia Communications, Inc
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

import { connect, Empty } from "jsr:@nats-io/nats-transport-deno@3.0.0-5";
import { AckPolicy, jetstreamManager } from "jsr:@nats-io/jetstream@3.0.0-18";

const nc = await connect();
const jsm = await jetstreamManager(nc);

// list all the streams, the `next()` function
// retrieves a paged result.
const streams = await jsm.streams.list().next();
streams.forEach((si) => {
  console.log(si);
});

// add a stream - jetstream can capture nats core messages
const subj = `mystream.*`;
await jsm.streams.add({ name: "mystream", subjects: [subj] });

// publish a reg nats message directly to the stream
for (let i = 0; i < 10; i++) {
  nc.publish(`mystream.a`, Empty);
}

// find a stream that stores a specific subject:
const name = await jsm.streams.find("mystream.A");

// retrieve info about the stream by its name
const si = await jsm.streams.info(name);

// update a stream configuration
si.config.subjects?.push("a.b");
await jsm.streams.update(name, si.config);

// get a particular stored message in the stream by sequence
// this is not associated with a consumer
const sm = await jsm.streams.getMessage("mystream", { seq: 1 });
console.log(sm.seq);

// delete the 5th message in the stream, securely erasing it
await jsm.streams.deleteMessage("mystream", 5);

// purge all messages in the stream, the stream itself
// remains.
await jsm.streams.purge("mystream");

// purge all messages with a specific subject (filter can be a wildcard)
await jsm.streams.purge("mystream", { filter: "a.b" });

// purge messages with a specific subject keeping some messages
await jsm.streams.purge("mystream", { filter: "a.c", keep: 5 });

// purge all messages with upto (not including seq)
await jsm.streams.purge("mystream", { seq: 100 });

// purge all messages with upto sequence that have a matching subject
await jsm.streams.purge("mystream", { filter: "a.d", seq: 100 });

// list all consumers for a stream:
const consumers = await jsm.consumers.list("mystream").next();
consumers.forEach((ci) => {
  console.log(ci);
});

// add a new durable pull consumer
await jsm.consumers.add("mystream", {
  durable_name: "me",
  ack_policy: AckPolicy.Explicit,
});

// retrieve a consumer's configuration
const ci = await jsm.consumers.info("mystream", "me");
console.log(ci);

// delete a particular consumer
await jsm.consumers.delete("mystream", "me");

// delete the stream
await jsm.streams.delete("mystream");

await nc.close();
