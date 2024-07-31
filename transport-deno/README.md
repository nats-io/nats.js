# NATS Deno Transport - A [NATS](http://nats.io) client for [Deno](https://deno.land)

A Deno transport for the [NATS messaging system](https://nats.io).

[![License](https://img.shields.io/badge/Licence-Apache%202.0-blue.svg)](./LICENSE)
![Test NATS.deno](https://github.com/nats-io/nats.deno/workflows/NATS.deno/badge.svg)
[![Coverage Status](https://coveralls.io/repos/github/nats-io/nats.deno/badge.svg?branch=main)](https://coveralls.io/github/nats-io/nats.deno?branch=main)

This module implements a Deno native TCP transport for the NATS clients. This
library exports the [NATS core](../core/README.md) library which implements all
basic NATS functionality.

# Installation

You can get the latest release version like this:

```typescript
import * as nats from "jsr:@nats-io/nats-transport-deno";
```

To specify a specific released version, simply replace nats with
nats@_versionTag_.

You can get the current development version by:

```typescript
import * as nats from "https://raw.githubusercontent.com/nats-io/nats.deno/main/src/types.ts";
```

To use [NATS JetStream](../jetstream/README.md), [NATS KV](../kv/README.md),
[NATS Object Store](../os/README.md), or the
[NATS Services](../service/README.md) functionality you'll need to install the
desired modules as described in each of the modules README files.

This module simply exports a
[`connect()` function](../core/README.md#connecting-to-a-nats-server) that
returns a `NatsConnection` supported by a Deno TCP socket. This library
re-exports all the public APIs for the [core](../core/README.md) module. Please
visit the core module for examples on how to use a connection or refer to the
[JSDoc documentation](https://nats-io.github.io/nats.deno).
