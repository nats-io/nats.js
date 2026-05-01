// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Multiple responders - only first response is returned
nc.subscribe("calc.add", {
  callback: (_err, msg) => {
    msg.respond("calculated result from A");
  },
});

nc.subscribe("calc.add", {
  callback: (_err, msg) => {
    msg.respond("calculated result from B");
  },
});

// Gets one response
try {
  const response = await nc.request("calc.add", "data");
  console.log(`Got response: ${response.string()}`);
} catch (e) {
  console.error(`Request failed: ${(e as Error).message}`);
}
// NATS-DOC-END

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
