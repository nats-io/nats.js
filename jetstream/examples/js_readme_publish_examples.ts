import { connect, Empty } from "jsr:@nats-io/nats-transport-deno@3.0.0-5";
import { jetstream, jetstreamManager } from "../src/mod.ts";
import type { PubAck } from "../src/mod.ts";

const nc = await connect();
const jsm = await jetstreamManager(nc);
await jsm.streams.add({ name: "a", subjects: ["a.*"] });

// create a jetstream client:
const js = jetstream(nc);

// publish a message received by a stream
let pa = await js.publish("a.b");
// the jetstream returns an acknowledgement with the
// stream that captured the message, it's assigned sequence
// and whether the message is a duplicate.
console.log(
  `stored in ${pa.stream} with sequence ${pa.seq} and is a duplicate? ${pa.duplicate}`,
);

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

// now if you have a stream with different subjects, you can also
// assert that the last recorded sequence on subject on the stream matches
const buf: Promise<PubAck>[] = [];
for (let i = 0; i < 100; i++) {
  buf.push(js.publish("a.a", Empty));
}
await Promise.all(buf);
// if additional "a.b" has been recorded, this will fail
await js.publish("a.b", Empty, { expect: { lastSubjectSequence: pa.seq } });
await nc.drain();
