import { connect, StringCodec } from '@nats-io/transport-node';

// Connect to NATS demo server
const nc = await connect({ servers: 'demo.nats.io' });

// Create encoder
const sc = StringCodec();

// Publish a message
nc.publish('hello', sc.encode('Hello NATS!'));
console.log('Message published to hello');

// Close connection
await nc.close();
