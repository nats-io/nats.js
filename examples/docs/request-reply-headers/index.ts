// import the connect function from a transport
import { connect, headers } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Header Aware service
nc.subscribe("service", {
  callback: (_err, msg) => {
    const h = headers();
    const id = msg.headers?.get("X-Request-ID");
    if (id) {
      h.append("X-Response-ID", id);
      h.append("X-Request-ID", id);
    }
    const pri = msg.headers?.get("X-Priority");
    if (pri) {
      h.append("X-Priority", pri);
    }
    msg.respond(msg.data, {headers: h})
  },
});

// Create message with headers
const h = headers();
h.append("X-Request-ID", "123");
h.append("X-Priority", "high");

const response = await nc.request("service", "data", {headers: h, timeout:1000});
console.log(`Response: ${response.string()}`);
const responseId = response.headers?.get("X-Response-ID");
if (responseId) {
  console.log(`Response ID: ${responseId}`);
}
// NATS-DOC-END

await nc.drain();
