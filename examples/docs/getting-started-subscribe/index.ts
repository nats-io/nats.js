// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// subscribe to the 'hello' subject
const sub = nc.subscribe("hello");
console.log("Listening for messages on 'hello'...");

// iterate over messages received
for await (const msg of sub) {
  console.log(`Received: ${msg.string()}`);
}

// drain will close the connection after processing pending messages
await nc.drain();
