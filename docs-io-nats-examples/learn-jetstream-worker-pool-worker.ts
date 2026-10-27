// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import { jetstream } from "@nats-io/jetstream";

// connect to the NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Bind to the durable "shipping" consumer created earlier.
const js = jetstream(nc);
const c = await js.consumers.get("ORDERS", "shipping");

// consume() yields the orders the server hands this worker. Run this same
// program in several processes: they all share the one "shipping" consumer, and
// the server splits the stored orders across them, one order to one worker.
const messages = await c.consume();
for await (const m of messages) {
  console.log(`shipping ${m.string()}`);
  m.ack();
}
// NATS-DOC-END

await nc.drain();
