// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

// connect to NATS server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
async function subscribeAndIterate(subject: string) {
  const sub = nc.subscribe(subject);
  const label = `[${subject}]`.padEnd(23);
  for await (const msg of sub) {
    console.log(`${label}${msg.string().padEnd(15)} (${msg.subject})`);
  }
}

subscribeAndIterate("sensor.alarm.*").catch(console.error);
subscribeAndIterate("sensor.*.*.critical").catch(console.error);
subscribeAndIterate("sensor.>").catch(console.error);

// Publish to specific subjects
nc.publish("sensor.alarm.smoke", "kitchen,14:22");
nc.publish("sensor.alarm.smoke.critical", "kitchen,14:23");
nc.publish("sensor.alarm.water", "basement,16:42");
nc.publish("sensor.alarm.water.critical", "basement,16:43");
// NATS-DOC-END

await new Promise((resolve) => setTimeout(resolve, 100));

await nc.drain();
