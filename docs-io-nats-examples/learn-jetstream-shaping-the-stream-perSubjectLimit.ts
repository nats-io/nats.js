// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";
import { jetstreamManager } from "@nats-io/jetstream";

// connect to the NATS server
const nc = await connect({ servers: "nats://localhost:4222" });

// NATS-DOC-START
// Add a per-subject ceiling so one noisy subject can't evict another's
// messages. max_msgs_per_subject keeps the most recent N messages for every
// subject independently, alongside the whole-stream limits.
const jsm = await jetstreamManager(nc);
await jsm.streams.update("ORDERS", { max_msgs_per_subject: 100000 });
console.log("ORDERS now keeps 100000 messages per subject");
// NATS-DOC-END

await nc.drain();
