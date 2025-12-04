import { connect, StringCodec } from '@nats-io/transport-node';

// Connect to NATS
const nc = await connect({ servers: 'localhost:4222' });
console.log('Connected to NATS');

// Create encoder
const sc = StringCodec();

// NATS-DOC-START
// Publish messages
nc.publish('hello', sc.encode('Hello NATS!'));
nc.publish('hello', sc.encode('Welcome to messaging'));
// NATS-DOC-END

console.log('Messages published');

// Close connection
await nc.close();
