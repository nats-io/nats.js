# nst-remote

Drop-in remote backend for `@nats-io/nst`. Spawns and manages NATS servers via
the [synadia-labs/testing.go](https://github.com/synadia-labs/testing.go)
management service over NATS micro, instead of forking `nats-server` locally.

Same public surface as `@nats-io/nst`. Tests select between local (`nst`) and
remote (`nst-remote`) at build/run time via Deno import map or Node conditional
exports — zero test edits for the common case.

## v0 scope

- Target `core/tests/` only.
- JetStream, KV, Obj, Services suites land in subsequent phases.
- Tests that need launcher features absent from testing.go (signal, reload, log,
  dynamic cluster grow) import local `@nats-io/nst` directly inside that test,
  bypassing the import map. No skip-gates required — tests pick the right tool
  explicitly.

## Goals

- Reuse existing test suites against remote-managed servers without code changes
  in the common case.
- Keep `nst` (local) unchanged in behavior.
- Surface parity enforced by a shared `ManagedServer` interface.

## Non-goals

- Replace local `nst`. Both ship side-by-side.
- Cover every advanced launcher feature on day one.
- Provide a Node-only flow — Deno-first like the rest of the repo.

## Selection mechanism

### Deno — separate `deno.remote.json` at repo root

Existing `deno.json` unchanged. New `deno.remote.json` overrides one entry:

```json
{
  "imports": {
    "@nats-io/nst": "./nst-remote/src/mod.ts"
  }
}
```

Tasks pick via `--config`:

```json
"tasks": {
  "test-core-remote": "deno test --config deno.remote.json --allow-all core/tests/"
}
```

### Node — `#nst` conditional in `transport-node/package.json`

```json
{
  "imports": {
    "#nst": {
      "nst-remote": "@nats-io/nst-remote",
      "default": "@nats-io/nst"
    }
  }
}
```

Tests change one thing: `require("@nats-io/nst")` → `require("#nst")` (~6
files). Run remote variant: `node --conditions=nst-remote --test tests/`.

### Escape hatch

For tests that genuinely need local-only launcher features, import explicitly:

```ts
import { NatsServer as LocalNatsServer } from "@nats-io/nst";
```

This bypasses the import map and always resolves to the local launcher. Affected
core tests (v0):

- `core/tests/events_test.ts` — `addClusterMember`, `signal` LDM
- `core/tests/mrequest_test.ts` — `reload`
- `core/tests/doublesubs_test.ts` — `getLog`

## Shared interface

Lift into `nst/src/managed.ts`:

```ts
export interface ManagedServer {
  hostname: string;
  port: number;
  monitoring?: number;
  websocket?: number;
  cluster?: number;
  clusterName?: string;

  connect(opts?: ConnectionOptions): Promise<NatsConnection>;
  stop(cleanup?: boolean): Promise<void>;
  restart(): Promise<ManagedServer>;

  varz(): Promise<VarZ>;
  jsz(): Promise<JSZ>;
  connz(cid?: number, subs?: boolean | "detail"): Promise<ConnZ>;
  leafz(): Promise<{ leafs: unknown[]; leafnodes: number }>;

  signal(sig: string): Promise<void>; // remote throws
  reload(conf: unknown): Promise<void>; // remote throws
  getLog(): string; // remote throws
  pid(): number; // remote throws

  [Symbol.asyncDispose](): Promise<void>;
}
```

Local `NatsServer` and remote `NatsServer` both `implements ManagedServer`.

## Public surface (must match `@nats-io/nst`)

Exported from `nst-remote/src/mod.ts`:

| Export                            | Notes                                 |
| --------------------------------- | ------------------------------------- |
| `class NatsServer`                | Same static methods, backed by remote |
| `setup(serverConf?, clientOpts?)` | Identical signature                   |
| `cleanup(ns, ...nc)`              | Identical signature                   |
| `jsopts()`                        | Identical                             |
| `jetstreamServerConf(opts?)`      | Identical                             |
| `jetstreamExportServerConf(...)`  | Identical                             |
| `wsopts()` / `wsServerConf(...)`  | Identical                             |
| `notCompatible` / `notSupported`  | Identical (varz via sys req)          |
| `flakyTest`, `disabled`           | Re-export from `nst`                  |
| `Lock`, `check`, `assertBetween`  | Re-export from `nst`                  |
| `ServerSignals`                   | Re-export from `nst`                  |
| `getConnect` / `registerConnect`  | Re-export from `nst`                  |
| `TestServer` / `Connection`       | Re-export from `nst`                  |

`NatsServer` static methods:

- `start(conf?, debug?): Promise<NatsServer>`
- `cluster(count, conf?, debug?): Promise<NatsServer[]>`
- `jetstreamCluster(count, conf?, debug?): Promise<NatsServer[]>`
- `stopAll(servers, cleanup?): Promise<void[]>`
- `localClusterFormed(servers): Promise<void[]>` — no-op (service forms before
  responding)
- `dataClusterFormed(proms, debug?)` — no-op (same reason)
- `setupDataConnCluster(count?, debug?)` — implemented in a later phase via
  custom `WithTemplate` (`{{ if ne .ServerIndex 1 }}` JS block). Throws in v0.
- `addClusterMember(ns, conf?, debug?)` — throws v0 (no testing.go API). Tests
  requiring it use local import escape hatch.
- `tlsConfig()` — implemented in a later phase. Throws v0.

Instance methods returning data over NATS sys requests, not HTTP:

- `connect(opts?)` — uses URL/port from create response
- `varz()` / `jsz()` / `connz(cid?, subs?)` / `leafz()` — sys req
- `stop(cleanup?)` — `tester.destroy` if sole server in instance, else
  `tester.stop.server`; factory issues `tester.destroy` once all members of an
  instance have stopped with `cleanup: true`
- `restart()` — `tester.stop.server` + `tester.start.server`
- `[Symbol.asyncDispose]()` — `stop(true)`

Throws on remote (no testing.go API):

- `signal(sig)` — `Error("signal() not supported by nst-remote")`
- `reload(conf)` — same
- `getLog()` — same
- `pid()` — same

## Configuration model

`nst-remote` accepts the **same JavaScript config object** as `nst` and
translates server-side into testing.go's snippet + template model. Common tests
write plain conf objects, unaware of the backend.

### Translation table

| nst conf key                                 | testing.go mapping                           |
| -------------------------------------------- | -------------------------------------------- |
| `jetstream` (truthy)                         | `JetStream: true` on create request          |
| `jetstream.max_file_store` / `max_mem_store` | merged into `WithTopLevel` snippet           |
| `accounts`                                   | `WithAccounts` snippet (body rendered)       |
| `authorization`                              | `WithAuthorization` snippet                  |
| `system_account`                             | `WithSystemAccount` snippet                  |
| `tls`                                        | `WithTLS` snippet                            |
| `websocket`                                  | `WithWebSocket` snippet (auto-reserves port) |
| `mqtt`                                       | `WithMQTT` snippet                           |
| `leafnodes`                                  | `WithLeafNode` snippet                       |
| `cluster` (in single)                        | rejected; use `cluster()` factory            |
| `gateway`                                    | rejected at single-server                    |
| other keys                                   | merged into `WithTopLevel` free-form         |
| pre-rendered conf string                     | passed as `Template` (full override)         |

Drop unconditionally: `port: -1`, `cluster.listen: -1`, `http: -1` and similar
local-launcher port placeholders — service owns port assignment.

Audit finding: every existing `NatsServer.cluster(...)` /
`jetstreamCluster(...)` call in the repo passes **no custom config** beyond the
count. The translation table only needs to handle the `setup(...)` style configs
in v0.

### Serialization

For each snippet, `nst-remote` produces the **rendered config body** as a string
(no Go template tokens unless needed for port placeholders). For
listener-bearing snippets, the body uses `{{ .Ports.<name> }}` where required;
`nst-remote` generates that token from the user's config.

`nst-remote` reuses `toConf()` from `nst` (re-exported from `internal_mod.ts` if
needed) to serialize each snippet body.

## Sys monitoring

`varz` / `jsz` / `connz` / `leafz` go over `$SYS.REQ.SERVER.<id>.*` on a
lazily-opened sys-account NATS connection to the managed cluster.

### Sys connection

- One sys conn per unique mgmt URL (singleton in the factory)
- Default creds: `system / password` (matches testing.go default template)
- Override: `NST_REMOTE_SYS_USER`, `NST_REMOTE_SYS_PASS`
- If a test replaces the `accounts` snippet and drops the sys user, sys
  monitoring breaks — caller's responsibility (also breaks testing.go's own
  assumptions)

### Subjects

- `$SYS.REQ.SERVER.PING.VARZ` — broadcast; mapped once to discover
  `server_name → server_id`
- `$SYS.REQ.SERVER.<id>.VARZ`
- `$SYS.REQ.SERVER.<id>.JSZ`
- `$SYS.REQ.SERVER.<id>.CONNZ` — payload `{cid?, subs?: bool|"detail"}` JSON
- `$SYS.REQ.SERVER.<id>.LEAFZ`

### Caching

Per `RemoteNatsServer`:

- `serverId` — cached after first PING.VARZ
- `version` from varz — cached forever (process-lifetime constant)
- All other fields — live, no cache

## Cluster creation

Local `NatsServer.cluster(count, conf)` issues N sequential `addClusterMember`
calls. Remote issues **one** `tester.create.cluster` call; service forms the
cluster atomically and returns when ready. No polling.

Remote `cluster()` translates conf once into snippets and submits with
`Servers: count`. Per-node heterogeneity is **not supported** through this path.
For genuine heterogeneity:

- `setupDataConnCluster`: handled in a later phase via custom `WithTemplate`
  with `{{ if ne .ServerIndex 1 }}` to skip JS on the gateway node.
- `addClusterMember` (dynamic grow): not expressible in the current testing.go
  API. Tests requiring it use the local-import escape hatch.

## TLS

testing.go service hosts its own CA + server cert. nst-remote:

- `NatsServer.tlsConfig()` fetches CA + paths from the service (new subject
  needed upstream — see Open questions).
- Returns shape compatible with local
  `{tls: {cert_file, key_file, ca_file}, certsDir}`. `cert_file`/`key_file` are
  **service-side** filesystem paths (only valid inside the service's `WithTLS`
  snippet — opaque to the client). `ca_file` is a **client-side** temp file
  containing the fetched CA PEM, usable directly by the test client.
- mTLS client cert tests deferred.

Implemented in a follow-up phase, after core test coverage lands.

## Restart semantics

`RemoteNatsServer.restart()`:

1. Records current `name`.
2. `tester.stop.server { name }`.
3. `tester.start.server { name }`.
4. Refreshes `port` / `ports` / `serverId` from start response.

Assumption: testing.go preserves `name` but may reassign ports. Tests reading
`ns.port` post-restart use the returned `ManagedServer`'s new value.

## Cleanup

`stop(cleanup: true)`:

- If `RemoteNatsServer` is the sole server in its instance → `tester.destroy`
- Otherwise → `tester.stop.server`. After the last member of an instance stops
  with `cleanup: true`, the factory issues `tester.destroy` for that instance.

`Symbol.asyncDispose` destroys the instance.

## Discovery / configuration

Single env var: `NST_REMOTE_URL` = NATS URL of the management service (e.g.
`nats://localhost:4222`). Required; remote factory throws if missing on first
call.

Optional:

- `NST_REMOTE_SYS_USER`, `NST_REMOTE_SYS_PASS` — sys creds override
- `NST_REMOTE_USER`, `NST_REMOTE_PASS` — default test-user creds override
  (defaults to `user1 / password` from the testing.go template)
- `NST_REMOTE_DEBUG` — verbose request/response logging

## Module layout

```
nst-remote/
├── deno.json
├── package.json
├── README.md
├── LICENSE
├── SPEC.md
└── src/
    ├── mod.ts            # public exports (parity with nst)
    ├── server.ts         # class NatsServer implements ManagedServer
    ├── factory.ts        # start / cluster / jetstreamCluster
    ├── client.ts         # tester.* micro client
    ├── sys.ts            # $SYS.REQ.SERVER.* helpers + sys conn pool
    ├── translate.ts      # nst conf → testing.go snippets
    ├── types.ts          # api.go types ported
    └── version.ts        # auto-generated
└── tests/
    └── remote_test.ts    # smoke + parity tests
```

## Dependencies

- `@nats-io/nats-core` (peer)
- `@nats-io/nst` (peer — interface, types, `toConf`, re-exports)
- `@nats-io/transport-deno` (devDep — own tests)
- testing.go binary/container — CI dependency

## Build & publish

Same flow as other nst modules:

- `pre-process` → `cjs-fix-imports.ts`
- `build-cjs` → `tsc`
- Publish to JSR + npm as `@nats-io/nst-remote`
- Version in lockstep with `nst`; extend `bin/check-versions.ts`

## CI

New job `nst-remote-checks.yml`:

- Launch testing.go (Docker container from the upstream repo)
- Wait for the mgmt NATS port ready
- `NST_REMOTE_URL=nats://localhost:4222`
- Run `deno task test-core-remote`

JetStream/KV/Obj/Services remote jobs land in subsequent phases.

## Phases

1. **Interface extraction** in `nst` (`managed.ts`);
   `NatsServer implements
   ManagedServer`. PR 1.
2. **`nst-remote` scaffold**: dir, deno.json, package.json, README, SPEC, types
   ported. PR 2.
3. **Mgmt client**: `tester.*` micro client + create/destroy round-trip covered
   by standalone tests. PR 3.
4. **Server wrapper + sys monitoring**: `RemoteNatsServer`, varz/connz via sys,
   connection wiring. PR 4.
5. **Conf translation**: snippet emission for the `setup(...)` configs the core
   suite passes. Cluster paths need no translation work in v0 — every
   `cluster()`/`jetstreamCluster()` callsite passes only a count. PR 5.
6. **Escape-hatch migration**: switch 3 advanced core tests to local-import.
   PR 6.
7. **`deno.remote.json` + CI**: testing.go container, `test-core-remote` job.
   PR 7.
8. Follow-ups: JetStream/KV/Obj/Services suites, TLS, `setupDataConnCluster`
   template, `addClusterMember` upstream API.

## Open questions

- TLS subject design — propose `tester.certs` returning
  `{ca_pem, server_cert_path, server_key_path}`?
- Restart port preservation — does testing.go reassign ports on
  `tester.start.server` for a previously stopped name?
- testing.go runtime in CI — Docker container, downloaded binary, or
  `go install`?
- Concurrent tests — one mgmt service handles many parallel test instances? Rate
  / contention limits known?
- Lockstep versioning — extend `bin/check-versions.ts` or treat `nst-remote`
  independently?
- `addClusterMember` — request `tester.add.server` subject upstream, or keep
  local-import workaround long-term?
