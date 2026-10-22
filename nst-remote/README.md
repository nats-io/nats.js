# @nats-io/nst-remote

Drop-in remote backend for `@nats-io/nst`. Manages NATS servers via the
[synadia-labs/testing.go](https://github.com/synadia-labs/testing.go) micro
service over NATS, instead of forking `nats-server` locally.

Same public surface as `@nats-io/nst`. Tests select between local and remote via
Deno import map or Node conditional exports — see `SPEC.md`.

Internal test helper — not a supported public API.

## Configuration

| Env var               | Purpose                                  | Default    |
| --------------------- | ---------------------------------------- | ---------- |
| `NST_REMOTE_URL`      | NATS URL of mgmt service                 | required   |
| `NST_REMOTE_SYS_USER` | Sys account user for `$SYS.REQ.SERVER.*` | `system`   |
| `NST_REMOTE_SYS_PASS` | Sys account password                     | `password` |
| `NST_REMOTE_USER`     | Default test-user                        | `user1`    |
| `NST_REMOTE_PASS`     | Default test-user password               | `password` |
| `NST_REMOTE_DEBUG`    | Verbose request/response logging         | unset      |

## Unsupported on remote

`signal()`, `reload()`, `getLog()`, `pid()`, dynamic `addClusterMember()` throw
at runtime. Tests requiring these import local `@nats-io/nst` directly.
