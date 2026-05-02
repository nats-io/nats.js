// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Create three workers in the same queue group
async function subscribeAndIterate(label: string) {
  const sub = nc.subscribe("orders.new", { queue: "workers" });
  for await (const msg of sub) {
    console.log(`Worker ${label} processed: ${msg.string()}`);
  }
}

subscribeAndIterate("A").catch(console.error);
subscribeAndIterate("B").catch(console.error);
subscribeAndIterate("C").catch(console.error);

// Publish messages - automatically load balanced
for (let i = 1; i <= 10; i++) {
  nc.publish("orders.new", `Order ${i}`);
}
// NATS-DOC-END

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
