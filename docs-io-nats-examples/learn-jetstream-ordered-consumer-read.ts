// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import { jetstream } from "@nats-io/jetstream";

// connect to the NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Ask for an ordered consumer over the stream: consumers.get() with no consumer
// name returns one. There's no ack to send — the library runs the consumer for
// you and recreates it if it ever misses a message, so you read every order in
// stream order.
const js = jetstream(nc);
const c = await js.consumers.get("ORDERS");

// Read the whole log once, in order, stopping when caught up (pending 0).
const messages = await c.consume();
for await (const m of messages) {
  console.log(`order ${m.string()}`);
  if (m.info.pending === 0) {
    break;
  }
}
// NATS-DOC-END

await nc.drain();
