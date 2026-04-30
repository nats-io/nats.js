# CLAUDE.md - nats.js

NATS.js v3 monorepo: JavaScript/TypeScript client libraries for NATS messaging.
Supports Deno, Node.js/Bun, and browser (W3C WebSocket) runtimes.

## Repository Structure

This is a **dual workspace** monorepo — Deno workspace (`deno.json`) for
development/testing and npm workspace (`package.json`) for Node.js publishing.

### Modules (under `@nats-io` scope on JSR and npm)

| Directory         | Package                   | Description                                                                          | Dependencies         |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------ | -------------------- |
| `core/`           | `@nats-io/nats-core`      | Base NATS client (protocol, connection, pub/sub, request/reply, WebSocket transport) | nkeys, nuid          |
| `jetstream/`      | `@nats-io/jetstream`      | JetStream (persistent streaming)                                                     | nats-core            |
| `kv/`             | `@nats-io/kv`             | Key-Value store                                                                      | nats-core, jetstream |
| `obj/`            | `@nats-io/obj`            | Object Store                                                                         | nats-core, jetstream |
| `services/`       | `@nats-io/services`       | Services framework                                                                   | nats-core            |
| `transport-deno/` | `@nats-io/transport-deno` | TCP transport for Deno                                                               | nats-core            |
| `transport-node/` | `@nats-io/transport-node` | TCP transport for Node.js/Bun                                                        | nats-core            |

### Other directories

- `test_helpers/` — Shared Deno test utilities (NatsServer launcher, Lock,
  setup/cleanup helpers)
- `bin/` — Build/release tooling scripts (version checks, CJS import fixer,
  bundler)
- `docs/` — Generated JSDoc documentation

## Development Commands

**Primary toolchain is Deno.** Source is written in TypeScript with `.ts`
extensions. Node.js packages are built via a CJS transpilation step.

### Deno (primary — runs all module tests)

```bash
deno task test              # Clean, lint, then run all module tests
deno task test-core         # Test only core module
deno task test-jetstream    # Test only jetstream module
deno task test-kv           # Test only kv module
deno task test-obj          # Test only obj module
deno task test-services     # Test only services module
deno task test-unsafe       # Test TLS unsafe tests (core/unsafe_tests/)
deno task test-transport-deno  # Test Deno transport

deno task lint              # Lint all modules (runs deno lint per module)
deno fmt                    # Format all code
deno fmt --check            # Check formatting without modifying

deno task clean             # Remove build artifacts and coverage
deno task cover             # Generate and open HTML coverage report
deno task check-versions    # Verify version consistency across modules
```

### Node.js (transport-node only)

```bash
# From repo root:
npm install --workspaces
npm run build --workspaces          # Build all workspace packages for npm
npm run prepack --workspaces        # Same as build (prepack calls build)

# From transport-node/:
npm test                             # Build then run Node.js test suite
npm run coverage                     # Build then run with lcov output
```

### Module npm build process (core, jetstream, kv, obj, services)

Each module's npm build:

1. `npm run pre-process` — runs `bin/cjs-fix-imports.ts` to copy `.ts` sources
   to `build/src/` with import paths fixed for CJS (removes `.ts` extensions)
2. `npm run build-cjs` — runs `tsc` to compile `build/src/` into `lib/`

The `transport-node` package compiles directly from `src/` to `lib/` (no
pre-process step).

## Code Conventions

### Source layout per module

- `src/mod.ts` — Public API exports (what consumers import)
- `src/internal_mod.ts` — Internal/extended API exports (used by other modules
  in the monorepo via `@nats-io/<pkg>/internal`)
- `src/types.ts` — Type definitions
- `src/version.ts` — Auto-generated version string (do not edit manually)
- `tests/` — Deno test files (`*_test.ts`)

### TypeScript style

- **Deno-first**: All source uses `.ts` extensions in imports (e.g.,
  `import { foo } from "./bar.ts"`)
- **Strict mode**: `"strict": true` in `deno.json` compilerOptions
- **Formatting**: `deno fmt` (2-space indent, double quotes implied by Deno
  defaults)
- **Linting**: `deno lint` per module
- **No eslint/prettier** — Deno's built-in formatter and linter are the only
  tools
- **Separate `type` imports**: Use `import type { Foo }` for type-only imports,
  `import { Bar }` for values
- **Error classes**: Custom error classes extend `Error`, set `this.name` in
  constructor (see `core/src/errors.ts`)
- **License header**: All source files must include the Apache 2.0 license
  header (see any `.ts` file)
- **Minimal external dependencies**: Avoid adding new dependencies. The project
  targets multiple runtimes.

### Module cross-references (Deno workspace)

In the Deno workspace, modules reference each other via scoped imports mapped to
local paths in root `deno.json`:

- `@nats-io/nats-core` maps to `./core/src/mod.ts`
- `@nats-io/nats-core/internal` maps to `./core/src/internal_mod.ts`
- Same pattern for jetstream, kv, obj, services

### Transport pattern

Each transport (Deno, Node, WebSocket) implements the `Transport` interface from
core and registers itself via `setTransportFactory()`. The `connect()` function
is transport-specific. WebSocket transport (`wsconnect`) is built into core.

### `transport-node/src/nats-base-client.ts`

This file is just `export * from "@nats-io/nats-core/internal"` — it re-exports
the core internals for the Node transport. The Node transport source files omit
`.ts` extensions in imports (they compile directly with `tsc`).

## Testing

### Deno tests

- Use `Deno.test("description", async () => { ... })` — Deno's built-in test
  runner
- Assertions from `@std/assert` (`assert`, `assertEquals`, `assertRejects`,
  `assertThrows`, etc.)
- Tests require a running `nats-server` binary (automatically launched by
  `test_helpers/launcher.ts`)
- Test helper pattern:
  `const ns = await NatsServer.start(config); const nc = await connect({port: ns.port}); ... await cleanup(ns, nc);`
- Or use `setup()` / `cleanup()` helpers from `test_helpers/mod.ts`
- Each module's tests import `connect` from a local `connect.ts` that re-exports
  from `test_helpers/connect.ts` (which uses the Deno transport)
- JetStream tests use `jetstreamServerConf()` to configure a server with
  JetStream enabled

### Node.js tests (transport-node/tests/)

- Uses Node.js built-in test runner (`node:test`): `describe()` / `it()` blocks
- Assertions from `node:assert`
- Test files are `.js` (they import from the built `lib/` directory)
- Has its own helper modules in `transport-node/tests/helpers/`

## CI Workflows

- **test.yml** — Main CI: runs on all pushes and PRs to main. Orchestrates:
  - `consistency_checks.yml` — `deno fmt --check` and `deno lint` per module,
    plus version consistency checks
  - `deno_checks.yml` — Runs `deno task test-<module>` for each module (core,
    jetstream, kv, obj, services, transport-deno)
  - `node_checks.yml` — Builds npm workspaces, runs `npm run coverage` in
    transport-node
  - `unsafe_checks.yml` — Runs TLS unsafe tests
- **transport-node-test.yml** — Triggered on changes to core modules; tests Node
  transport with local dependencies

## Version Management

- All modules share the same version number (currently synced)
- `version.ts` in each module is auto-generated — do not edit
- Use `deno task check-versions` to verify version consistency
- Use `deno task fix-versions` to auto-fix version mismatches
- Versions in `deno.json`, `package.json`, and `version.ts` must all agree per
  module

## Commit Conventions

- Commits should include `Signed-off-by` lines (`git commit -s`)
- Pull requests should reference issues with `Resolves #NNN`
- Avoid adding external dependencies
