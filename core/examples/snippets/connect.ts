/*
 * Copyright 2020-2021 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// import the connect function from a transport
import { connect } from "@nats-io/transport-deno";

const servers = [
  {},
  { servers: ["demo.nats.io:4442", "demo.nats.io:4222"] },
  { servers: "demo.nats.io:4443" },
  { port: 4222 },
  { servers: "localhost" },
];
servers.forEach(async (v) => {
  try {
    const nc = await connect(v);
    console.log(`connected to ${nc.getServer()}`);
    // this promise indicates the client closed
    const done = nc.closed();
    // do something with the connection

    // close the connection
    await nc.close();
    // check if the close was OK
    const err = await done;
    if (err) {
      console.log(`error closing:`, err);
    }
  } catch (_err) {
    console.log(`error connecting to ${JSON.stringify(v)}`);
  }
});
