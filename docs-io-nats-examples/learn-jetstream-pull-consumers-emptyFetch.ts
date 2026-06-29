// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import { jetstream } from "@nats-io/jetstream";

// connect to the NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Bind to the durable "shipping" consumer.
const js = jetstream(nc);
const c = await js.consumers.get("ORDERS", "shipping");

// A fetch on a drained consumer ends empty once the wait elapses, not with an
// error. Treat "nothing right now" as normal: if no orders came back, wait and
// fetch again instead of failing.
const msgs = await c.fetch({ max_messages: 10, expires: 2000 });
let count = 0;
for await (const m of msgs) {
  console.log(`shipping ${m.string()}`);
  m.ack();
  count++;
}
if (count === 0) {
  console.log("no orders waiting, will retry");
}
// NATS-DOC-END

await nc.drain();
