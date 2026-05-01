// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Service instance with queue group for load balancing
function createServiceInstance(instanceId: string) {
  const sub = nc.subscribe("api.calculate", { queue: "api-workers" });
  (async () => {
    for await (const msg of sub) {
      const data = msg.string().split(",");
      const result = parseInt(data[0]) + parseInt(data[1]);
      const response = `Result: ${result}, processed by: instance-${instanceId}`;
      msg.respond(response);
      console.log(`Instance ${instanceId} processed request`);
    }
  })().catch(console.error);
}

// Start multiple service instances
for (let i = 1; i <= 3; i++) {
  createServiceInstance(`instance-${i}`);
}

// Make requests - automatically load balanced
for (let i = 0; i < 10; i++) {
  try {
    const response = await nc.request("api.calculate", `${i},${i * 2}`, { timeout: 1000 });
    console.log(`Response: ${response.string()}`);
  } catch (e) {
    console.error(`Request failed: ${(e as Error).message}`);
  }
}
// NATS-DOC-END

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
