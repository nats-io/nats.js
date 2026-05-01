// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Set up a service
nc.subscribe("time", {
  callback: (_err, msg) => {
    const time = new Date().toISOString();
    msg.respond(time);
  },
});

// Make a request
try {
  const response = await nc.request("time", "");
  console.log(`Response: ${response.string()}`);
} catch (e) {
  console.error(`Request failed: ${(e as Error).message}`);
}
// NATS-DOC-END

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
