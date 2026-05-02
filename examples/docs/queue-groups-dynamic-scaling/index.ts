// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Worker that can be dynamically added/removed
function newWorker(id: string) {
  const sub = nc.subscribe("tasks", { queue: "workers" });
  (async () => {
    for await (const msg of sub) {
      console.log(`Worker ${id} processing: ${msg.string()}`);
      // Simulate work
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })().catch(console.error);
  return { id, sub };
}

// Dynamic scaling
const workers: ReturnType<typeof newWorker>[] = [];

// Scale up
for (let i = 1; i <= 5; i++) {
  workers.push(newWorker(`${i}`));
}

// Scale down
const removed = workers.pop();
if (removed) {
  removed.sub.unsubscribe();
}
// NATS-DOC-END

await new Promise((resolve) => setTimeout(resolve, 500));

await nc.drain();
