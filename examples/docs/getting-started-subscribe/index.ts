import { connect, StringCodec } from '@nats-io/transport-node';

// Connect to NATS
const nc = await connect({ servers: 'localhost:4222' });
console.log('Connected to NATS');

// Create decoder
const sc = StringCodec();

// NATS-DOC-START
// Subscribe to 'hello'
const sub = nc.subscribe('hello');
console.log('Waiting for messages...');

// Process messages
for await (const msg of sub) {
  console.log(`Received: ${sc.decode(msg.data)}`);
}
// NATS-DOC-END
