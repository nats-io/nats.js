// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// publish a message to the 'hello' subject
nc.publish("hello", "Hello NATS!");
console.log("Message published to hello");

// drain the connection (flushes and closes)
await nc.drain();
