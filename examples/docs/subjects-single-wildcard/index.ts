// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
async function subscribeAndIterate(subject: string) {
  const sub = nc.subscribe(subject);
  const label = `[${subject}]`.padEnd(20);
  for await (const msg of sub) {
    console.log(`${label}${msg.string()}  (${msg.subject})`);
  }
}

// Subscribe with single token wildcards
subscribeAndIterate("orders.*.shipped");
subscribeAndIterate("orders.*.placed");
subscribeAndIterate("orders.retail.*");

// Publish to specific subjects
nc.publish("orders.wholesale.placed", "Order W73737");
nc.publish("orders.retail.placed", "Order R65432");
nc.publish("orders.wholesale.shipped", "Order W73001");
nc.publish("orders.retail.shipped", "Order R65321");
// NATS-DOC-END

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
