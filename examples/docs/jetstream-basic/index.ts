// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import {
  AckPolicy,
  jetstream,
  jetstreamManager,
  StorageType,
} from "@nats-io/jetstream";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Create a stream that captures any subject under `orders.`
const jsm = await jetstreamManager(nc);
await jsm.streams.add({
  name: "ORDERS",
  subjects: ["orders.>"],
  storage: StorageType.File,
});

// Publish a few orders
const js = jetstream(nc);
await js.publish("orders.new", "Order #1001");
await js.publish("orders.new", "Order #1002");
await js.publish("orders.shipped", "Order #1001 shipped");

// Create a durable pull consumer that delivers from the beginning
await jsm.consumers.add("ORDERS", {
  durable_name: "order-processor",
  ack_policy: AckPolicy.Explicit,
});
const consumer = await js.consumers.get("ORDERS", "order-processor");

// Fetch a batch and acknowledge each message
const messages = await consumer.fetch({ max_messages: 3, expires: 5000 });
for await (const msg of messages) {
  console.log(`Received on ${msg.subject}: ${msg.string()}`);
  msg.ack();
}
// NATS-DOC-END

// drain the connection (flushes and closes)
await nc.drain();
