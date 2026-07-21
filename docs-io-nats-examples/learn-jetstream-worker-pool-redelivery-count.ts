// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import { jetstream } from "@nats-io/jetstream";

// connect to the NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Bind to the durable "shipping" consumer.
const js = jetstream(nc);
const c = await js.consumers.get("ORDERS", "shipping");

// Each message reports how many times it has been delivered. A count above one
// means a redelivery: the server handed this order out before, but a worker
// crashed or ran past AckWait before acking. Key your side effects by order_id
// so handling the same order twice is harmless.
const msgs = await c.fetch({ max_messages: 10, expires: 5000 });
for await (const m of msgs) {
  if (m.info.deliveryCount > 1) {
    console.log(`redelivery #${m.info.deliveryCount} of ${m.string()}`);
  } else {
    console.log(`first delivery of ${m.string()}`);
  }
  m.ack();
}
// NATS-DOC-END

await nc.drain();
