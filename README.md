# NATS.js - The JavaScript clients for [NATS](http://nats.io)

[![License](https://img.shields.io/badge/Licence-Apache%202.0-blue.svg)](./LICENSE)
[![JSDoc](https://img.shields.io/badge/JSDoc-reference-blue)](https://nats-io.github.io/nats.js/)

> [!IMPORTANT]
>
> This project reorganizes the NATS Base Client library (originally part of
> nats.deno), into multiple modules, and on-boards the supported transports
> (Deno, Node/Bun, and WebSocket).
>
> While there have been some important refactorings and minor API changes to
> address the split into multiple modules, the code is stable and you are
> welcomed to on-board it into your own projects, with the caveat that
> additional API changes are forthcoming. These changes will be advertised
> properly.
>
> This repository now supersedes:
>
> - [nats.deno](https://github.com/nats-io/nats.deno)
> - [nats.ws](https://github.com/nats-io/nats.ws)
> - Note that the old nats.js has been renamed to
>   [nats.node](https://github.com/nats-io/nats.node) so that the repository
>   _nats.js_ could be used for this project.
>
> Changes are well documented and should be easy to locate and implement, and
> are all described in [migration.md](migration.md).

Welcome to the new NATS.js repository! Beginning with the v3 release of the
JavaScript clients, the NATS.js repository reorganizes the NATS JavaScript
client libraries into a formal mono-repo.

This repository hosts native runtime support ("transports") for:

- Deno
- Node/Bun
- Browsers (W3C websocket)

A big change with the v3 clients is that the "nats-base-client" which implements
all the runtime agnostic functionality of the clients, is now split into several
modules. This split simplifies the initial user experience as well as the
development and evolution of the JavaScript clients and new functionality.

The new modules are:

- [Core](core/README.md) which implements basic NATS core functionality
- [JetStream](jetstream/README.md) which implements JetStream functionality
- [Kv](kv/README.md) which implements NATS KV functionality (uses JetStream)
- [Obj](obj/README.md) which implements NATS Object Store functionality (uses
  JetStream)
- [Services](services/README.md) which implements a framework for building NATS
  services

If you are getting started with NATS for the first time, you'll be able to pick
one of our technologies and more easily incorporate it into your apps. Perhaps
you heard about the NATS KV and would like to incorporate it into your app. The
KV module will shortcut a lot of concepts for you. You will of course need a
transport which will allow you to `connect` to a NATS server, but once you know
how to create a connection you will be focusing on a smaller subset of the APIs
rather than be confronted with all the functionality you available to a NATS
client. From there, we are certain that you will broaden your use of NATS into
other areas, but your initial effort should be more straight forward.

Another reason for the change is that, the new modules have the potential to
make your client a bit smaller, and if versions change on a submodule that you
don't use, you won't be confronted with an upgrade choice. These modules also
allows us to version more strictly, and thus telegraph to you the effort or
scope of changes in the update and prevent surprises when upgrading.

By decoupling of the NATS client functionality from a transport, we enable NATS
developers to create new modules that can run in all runtimes so long as they
follow a pattern where a `NatsConnection` (or some other standard interface) is
used as the basis of the module. For example, the JetStream module exposes the
`jetstream()` and `jetstreamManager()` functions that return the JetStream API
to interact with JetStream for creating resources or consuming streams. The
actual connection type is not important, and the library will work regardless of
the runtime provided so long as the runtime has the minimum support required by
the library.

# Getting Started

For a quick overview of the libraries and how to install them, see
[runtimes.md](runtimes.md).

If you are migrating from the legacy nats.deno or nats.js or nats.ws clients
don't despair. Changes are well documented and should be easy to locate and
implement, and are all [described in migration.md](migration.md).

If you want to get started with NATS the best starting point is the transport
that matches the runtime you want to use:

- [Deno Transport](transport-deno/README.md) which implements a TCP transport
  for [Deno](https://deno.land)
- [Node Transport](transport-node/README.md) which implements a TCP transport
  for [Node](https://nodejs.org) and [Bun](https://bun.sh).
- For browser [W3C Websocket] runtimes, the websocket client is now part of the
  [Core](core/README.md), as some runtimes such as Deno and Node v22 support it
  natively.

The module for the transport will tell you how to install it, and how to use it.

If you want to write a library that uses NATS under the cover, your starting
point is likely [Core](core/README.md). If data oriented, it may be
[JetStream](jetstream/README.md).

## Documentation

Each of the modules has an introductory page that shows the main API usage for
the module. You can access it's
[JSDoc here](https://nats-io.github.io/nats.js/).

## Contributing

If you are interested in contributing to NATS, read about our...

- [Contributing guide](./CONTRIBUTING.md)
- [Report issues or propose Pull Requests](https://github.com/nats-io)
