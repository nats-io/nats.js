# NATS.js - The JavaScript clients for [NATS](http://nats.io)

[![License](https://img.shields.io/badge/Licence-Apache%202.0-blue.svg)](./LICENSE)
![Test NATS.deno](https://github.com/nats-io/nats.deno/workflows/NATS.deno/badge.svg)
[![Coverage Status](https://coveralls.io/repos/github/nats-io/nats.deno/badge.svg?branch=main)](https://coveralls.io/github/nats-io/nats.deno?branch=main)

> [!CAUTION] This project is still working in progress and not yet released.
> Currently supported Javascript are
>
> - [nats.deno](https://github.com/nats-io/nats.deno)
> - [nats.js](https://github.com/nats-io/nats.js)
> - [nats.ws](https://github.com/nats-io/nats.ws)

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
- [Services](obj/README.md) which implements a framework for building NATS
  services

If you are getting started with NATS for the first time, you'll be able to pick
one of our technologies and more easily incorporate it into your apps. Perhaps
you heard about the NATS KV and would like to incorporate it into your app. The
KV module will shortcut a lot of things for you. You will of course need a
transport which will allow you to `connect` you to a NATS server, but once you
know how to create a connection you will be focusing on a smaller subset of the
APIs rather than be confronted with all the functionality you can use in a NATS
client. From there, we are certain that you will broaden your use of NATS into
other areas, but your initial effort should be more straight forward.

Another reason for the change is that it has the potential to make your client a
bit smaller, and if versions change on a submodule that you don't use, you won't
be confronted with an upgrade choice. These modules also allows us to version
more strictly, and thus telegraph to you the effort or scope of changes and
prevent surprises when upgrading.

By decoupling of the NATS client functionality from a transport, we enable NATS
developers to create new modules that can run all runtimes so long as they
follow a pattern where a `NatsConnection` (or some other standard interface) is
used as the basis of the module. For example, the JetStream module exposes a
`jetstream()` and `jetstreamManager()` functions that will return a JetStream
API that you use to interact with JetStream for creating resources or consuming
streams. The actual connection type is not important, and the library will work
regardless of the runtime provided the runtime has the minimum support required
by the library.

# Getting Started

If you are migrating from the legacy nats.deno or nats.js or nats.ws clients
don't despair. Changes are well documented and should be easy to locate and
implement, and are all [described here](migration.md).

If you want to get started with NATS the best starting point is the transport
that matches the runtime you want to use:

- [Deno Transport](transport-deno/README.md) which implements a TCP transport
  for [Deno](https://deno.land)

The module for the transport will tell you how to install it, and how to use it.

If you want to write a library that uses NATS under the cover, your starting
point is likely [Core](core/README.md). If data oriented, it may be
[JetStream](jetstream/README.md).

## Documentation

Each of the modules has an introductory page that shows the main API usage for
the module. It also hosts its JsDoc.
