// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import { jetstreamManager } from "@nats-io/jetstream";

// connect to the NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Raise max_ack_pending so a larger pool can hold more orders in progress at
// once. The cap is shared across the whole "shipping" consumer, not per worker,
// so size it to at least your worker count.
const jsm = await jetstreamManager(nc);
await jsm.consumers.update("ORDERS", "shipping", { max_ack_pending: 5000 });
console.log("shipping max_ack_pending set to 5000");
// NATS-DOC-END

await nc.drain();
