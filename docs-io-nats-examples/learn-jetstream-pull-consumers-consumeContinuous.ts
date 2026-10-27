// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import { jetstream } from "@nats-io/jetstream";

// connect to the NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Bind to the durable "shipping" consumer.
const js = jetstream(nc);
const c = await js.consumers.get("ORDERS", "shipping");

// consume() sets up a continuous flow: the library keeps pull requests open and
// yields each order as soon as it lands in the stream. It runs until you stop
// it, no fetch loop to write by hand.
const messages = await c.consume();
for await (const m of messages) {
  console.log(`shipping ${m.string()}`);
  m.ack();
}
// NATS-DOC-END

await nc.drain();
