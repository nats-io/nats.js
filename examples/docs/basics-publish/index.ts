// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Publish a message to the "weather.updates" subject
nc.publish("weather.updates", "Temperature: 72°F");
// NATS-DOC-END
console.log("Message published to weather.updates");

// drain the connection (flushes and closes)
await nc.drain();
