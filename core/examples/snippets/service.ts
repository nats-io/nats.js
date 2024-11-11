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
import type { Subscription } from "@nats-io/transport-deno";

// create a connection
const nc = await connect({ servers: "demo.nats.io" });

// this subscription listens for `time` requests and returns the current time
const sub = nc.subscribe("time");
(async (sub: Subscription) => {
  console.log(`listening for ${sub.getSubject()} requests...`);
  for await (const m of sub) {
    if (m.respond(new Date().toISOString())) {
      console.info(`[time] handled #${sub.getProcessed()}`);
    } else {
      console.log(`[time] #${sub.getProcessed()} ignored - no reply subject`);
    }
  }
  console.log(`subscription ${sub.getSubject()} drained.`);
})(sub);

// this subscription listens for admin.uptime and admin.stop
// requests to admin.uptime returns how long the service has been running
// requests to admin.stop gracefully stop the client by draining
// the connection
const started = Date.now();
const msub = nc.subscribe("admin.*");
(async (sub: Subscription) => {
  console.log(`listening for ${sub.getSubject()} requests [uptime | stop]`);
  // it would be very good to verify the origin of the request
  // before implementing something that allows your service to be managed.
  // NATS can limit which client can send or receive on what subjects.
  for await (const m of sub) {
    const chunks = m.subject.split(".");
    console.info(`[admin] #${sub.getProcessed()} handling ${chunks[1]}`);
    switch (chunks[1]) {
      case "uptime":
        // send the number of millis since up
        m.respond(`${Date.now() - started}`);
        break;
      case "stop": {
        m.respond(`[admin] #${sub.getProcessed()} stopping....`);
        // gracefully shutdown
        nc.drain()
          .catch((err) => {
            console.log("error draining", err);
          });
        break;
      }
      default:
        console.log(
          `[admin] #${sub.getProcessed()} ignoring request for ${m.subject}`,
        );
    }
  }
  // the iterator will stop when the subscription closes or drains
  // so this line will print when that happens
  console.log(`subscription ${sub.getSubject()} closed.`);
})(msub);

// wait for the client to close here.
await nc.closed().then((err?: void | Error) => {
  let m = `connection to ${nc.getServer()} closed`;
  if (err) {
    m = `${m} with an error: ${err.message}`;
  }
  console.log(m);
});
