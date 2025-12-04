import { connect, StringCodec } from '@nats-io/transport-node';

// Connect to NATS demo server
const nc = await connect({ servers: 'demo.nats.io' });

// Create decoder
const sc = StringCodec();

// Subscribe to 'hello'
const sub = nc.subscribe('hello');
console.log("Listening for messages on 'hello'...");

// Process messages
for await (const msg of sub) {
  console.log(`Received: ${sc.decode(msg.data)}`);
}
