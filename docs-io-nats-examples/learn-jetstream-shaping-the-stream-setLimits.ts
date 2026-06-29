// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import { jetstreamManager } from "@nats-io/jetstream";

// connect to the NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Cap ORDERS with a seven-day age limit and a 1 GiB byte ceiling. streams.update
// takes just the fields you're changing and leaves the rest, and the stored
// messages, in place. max_age is in nanoseconds.
const jsm = await jetstreamManager(nc);
await jsm.streams.update("ORDERS", {
  max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days
  max_bytes: 1024 * 1024 * 1024, // 1 GiB
});
console.log("ORDERS capped at 7d age and 1 GiB");
// NATS-DOC-END

await nc.drain();
