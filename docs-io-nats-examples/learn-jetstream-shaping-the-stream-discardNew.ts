// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import { DiscardPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";

// connect to the NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Switch ORDERS to Discard New. Discard New never drops stored messages, so
// capping it at one message leaves the existing orders in place and puts the
// stream instantly over its limit; the next publish is rejected.
const jsm = await jetstreamManager(nc);
await jsm.streams.update("ORDERS", { discard: DiscardPolicy.New, max_msgs: 1 });

// This publish hits the full stream and rejects with "maximum messages
// exceeded" instead of succeeding silently. Handle it in the publisher.
const js = jetstream(nc);
try {
  await js.publish("orders.created", JSON.stringify({ order_id: "ord_8w2k" }));
} catch (err) {
  console.log(`publish rejected: ${(err as Error).message}`);
}

// Put ORDERS back: Discard Old, no message cap (age and byte limits stay).
await jsm.streams.update("ORDERS", { discard: DiscardPolicy.Old, max_msgs: -1 });
// NATS-DOC-END

await nc.drain();
