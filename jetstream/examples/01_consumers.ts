/*
 * Copyright 2023 The NATS Authors
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

import { connect } from "jsr:@nats-io/nats-transport-deno@3.0.0-5";
import { jetstream } from "../src/mod.ts";
import { setupStreamAndConsumer } from "./util.ts";

// create a connection
const nc = await connect();

const { stream, consumer } = await setupStreamAndConsumer(nc);

// retrieve an existing consumer
const js = jetstream(nc);
const c = await js.consumers.get(stream, consumer);
console.log(await c.info(true));

// getting an ordered consumer requires no name
// as the library will create it
const oc = await js.consumers.get(stream);
console.log(await oc.info(true));

await nc.close();
