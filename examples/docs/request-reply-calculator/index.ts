// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Calculator service
nc.subscribe("calc.add", {
  callback: (_err, msg) => {
    const parts = msg.string().split(/\s+/);
    if (parts.length === 2) {
      const a = parseInt(parts[0], 10);
      const b = parseInt(parts[1], 10);
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        msg.respond(String(a + b));
      }
    }
  },
});

// Make calculations
await new Promise((resolve) => setTimeout(resolve, 100));

let resp = await nc.request("calc.add", "5 3");
console.log(`5 + 3 = ${resp.string()}`);

resp = await nc.request("calc.add", "10 7");
console.log(`10 + 7 = ${resp.string()}`);
// NATS-DOC-END

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
