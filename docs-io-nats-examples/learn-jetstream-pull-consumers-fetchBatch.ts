// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import { jetstream } from "@nats-io/jetstream";

// connect to the NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Bind to the durable "shipping" consumer.
const js = jetstream(nc);
const c = await js.consumers.get("ORDERS", "shipping");

// Fetch a batch of up to 10 orders, waiting up to 2 seconds for them. The call
// returns when the batch is full or the wait elapses, whichever comes first.
// Process and ack each, then fetch again to keep going.
const msgs = await c.fetch({ max_messages: 10, expires: 2000 });
for await (const m of msgs) {
  console.log(`shipping ${m.string()}`);
  m.ack();
}
// NATS-DOC-END

await nc.drain();
