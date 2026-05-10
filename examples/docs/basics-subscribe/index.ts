// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Subscribe to the "weather.updates" subject; auto-close after 1 message
const sub = nc.subscribe("weather.updates", { max: 1, timeout: 5000 });
// NATS-DOC-END
console.log("Listening for messages on 'weather.updates'...");

// iterate over messages received
for await (const msg of sub) {
  console.log(`Received: ${msg.string()}`);
}

// drain will close the connection after processing pending messages
await nc.drain();
