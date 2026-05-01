# @nats-io/nst

> **Status: internal/unsupported.** `@nats-io/nst` exists to support tests
> within the `nats.js` repo. It is published so the test suite can install it
> like any other workspace member, but it is **not** a stable public API.
> Symbols, behavior, and signatures may change without notice. Do not depend on
> it outside this repo without expecting churn.

Shared test utilities for `nats.js` modules. Provides:

- `NatsServer` — spawns/manages a `nats-server` binary for tests (single,
  cluster, leafnode).
- `setup` / `cleanup` — quick test fixtures returning a server + connection.
- `jetstreamServerConf` / `jetstreamExportServerConf` / `wsServerConf` — config
  builders.
- `Lock`, `check`, `assertBetween`, `flakyTest` — small test helpers.
- `Connection`, `TestServer` — fake-NATS TCP server for protocol tests.
- `registerConnect` / `getConnect` — transport injection (see below).

Runs on Deno and Node.js (≥ 20). The package never imports a transport — the
caller registers `connect` from their transport package.

## Requirements

- `nats-server` binary on `PATH`. Install:
  https://github.com/nats-io/nats-server/releases
- Node.js ≥ 20 or Deno ≥ 2.

## Install

```sh
# npm
npm i -D @nats-io/nst

# JSR / Deno
deno add jsr:@nats-io/nst
```

`@nats-io/nats-core` is a peer dependency — your project provides it.

## Bootstrap

`@nats-io/nst` does not import a transport. Each test runtime must register one
once before calling `setup()` or `NatsServer.connect()`:

### Deno (transport-deno)

```ts
// tests/connect.ts
import { connect } from "@nats-io/transport-deno";
import { registerConnect } from "@nats-io/nst";
registerConnect(connect);
export { connect };
```

### Node.js (transport-node)

```js
// tests/connect.js
const { connect } = require("@nats-io/transport-node");
const { registerConnect } = require("@nats-io/nst");
registerConnect(connect);
module.exports = { connect };
```

Tests then import `setup`, `cleanup`, `NatsServer`, etc. from `@nats-io/nst` and
the registered `connect` is used internally.

## Example

```ts
import { cleanup, jetstreamServerConf, setup } from "@nats-io/nst";
import "./connect.ts";

Deno.test("publish/subscribe", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  // ... use nc ...
  await cleanup(ns, nc);
});
```

## Cluster / leafnode

```ts
const cluster = await NatsServer.cluster(3);
// ...
await NatsServer.stopAll(cluster, true);
```

`NatsServer` exposes `varz()`, `jsz()`, `connz()`, `leafz()` for monitoring
endpoint queries.

## License

Apache 2.0
