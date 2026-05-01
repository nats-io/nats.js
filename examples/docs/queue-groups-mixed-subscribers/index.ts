// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Audit logger - receives all messages
const auditSub = nc.subscribe("orders.>");
(async () => {
  for await (const msg of auditSub) {
    console.log(`[AUDIT] ${msg.subject}: ${msg.string()}`);
  }
})().catch(console.error);

// Metrics collector - receives all messages
const metricsSub = nc.subscribe("orders.>");
(async () => {
  for await (const msg of metricsSub) {
    console.log(`[METRICS] ${msg.subject}: ${msg.string()}`);
  }
})().catch(console.error);

// Workers in queue group - load balanced
async function subscribeWorker(label: string) {
  const sub = nc.subscribe("orders.new", { queue: "workers" });
  for await (const msg of sub) {
    console.log(`[WORKER ${label}] Processing: ${msg.string()}`);
    processOrder(msg.string());
  }
}

subscribeWorker("A").catch(console.error);
subscribeWorker("B").catch(console.error);

// Publish order
nc.publish("orders.new", "Order 123");
nc.publish("orders.new", "Order 124");
// Audit and metrics see them, one worker processes each
// NATS-DOC-END

function processOrder(_data: string) {
  // Process order implementation
}

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
