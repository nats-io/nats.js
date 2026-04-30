// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Create a wire tap for monitoring
(async () => {
  for await (const msg of sub) {
    console.log(`[MONITOR] ${msg.subject}: ${msg.string()}`);
  }
})().catch(console.error);
(async () => {
  for await (const msg of sub) {
    console.log(`[MONITOR] ${msg.subject}: ${msg.string()}`);
  }
})();
// NATS-DOC-END

nc.publish("hello", "Hello NATS!");
nc.publish("event.new", "click");
nc.publish("weather.north.fr", "Temperature: 11°C");

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
