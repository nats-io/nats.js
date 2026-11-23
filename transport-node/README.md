# NATS Node Transport - A [NATS](http://nats.io) client for [Node.Js](https://nodejs.org/en/)

A Node.js transport for the [NATS messaging system](https://nats.io).

[![License](https://img.shields.io/badge/Licence-Apache%202.0-blue.svg)](https://github.com/nats-io/nats.js/blob/main/transport-node/LICENSE)
[![transport-node](https://github.com/nats-io/nats.js/actions/workflows/transport-node-test.yml/badge.svg)](https://github.com/nats-io/nats.js/actions/workflows/transport-node-test.yml)
[![JSDoc](https://img.shields.io/badge/JSDoc-reference-blue)](https://nats-io.github.io/nats.js)

[![NPM Version](https://img.shields.io/npm/v/%40nats-io%2Ftransport-node)](https://www.npmjs.com/package/@nats-io/transport-node)
[![NPM Downloads](https://img.shields.io/npm/dt/%40nats-io%2Ftransport-node)](https://www.npmjs.com/package/@nats-io/transport-node)
[![NPM Downloads](https://img.shields.io/npm/dm/%40nats-io%2Ftransport-node)](https://www.npmjs.com/package/@nats-io/transport-node)

This module implements a Node.js native TCP transport for NATS. This library
re-exports
[NATS core](https://github.com/nats-io/nats.js/blob/main/core/README.md) library
which implements all basic NATS client functionality. This library is compatible
with [Bun](https://bun.sh/).

# Installation

```bash
npm install @nats-io/transport-node
# or
bun install @nats-io/transport-node
```

You can then import the `connect` function to connect using the node transport
like this:

```typescript
import { connect } from "@nats-io/transport-node";
```

To use
[NATS JetStream](https://github.com/nats-io/nats.js/blob/main/jetstream/README.md),
[NATS KV](https://github.com/nats-io/nats.js/blob/main/kv/README.md),
[NATS Object Store](https://github.com/nats-io/nats.js/blob/main/obj/README.md),
or the
[NATS Services](https://github.com/nats-io/nats.js/blob/main/services/README.md)
functionality you'll need to install the desired modules as described in each of
the modules README files.

This module simply exports a
[`connect()` function](https://github.com/nats-io/nats.js/blob/main/core/README.md#connecting-to-a-nats-server)
that returns a `NatsConnection` supported by a Nodejs TCP socket. This library
re-exports all the public APIs for the
[core](https://github.com/nats-io/nats.js/blob/main/core/README.md) module.
Please visit the core module for examples on how to use a connection or refer to
the [JSDoc documentation](https://nats-io.github.io/nats.deno).

## Supported Node Versions

Our support policy for Nodejs versions follows
[Nodejs release support](https://github.com/nodejs/Release). We will support and
build node-nats on even-numbered Nodejs versions that are current or in LTS.
