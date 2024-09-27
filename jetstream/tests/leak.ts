import { connect } from "test_helpers";
import { jetstream } from "../src/mod.ts";

const nc = await connect();
const js = jetstream(nc);
// const jsm = await jetstreamManager(nc);
// await jsm.consumers.add("stream", {name: "test", ack_policy: AckPolicy.Explicit});
// const c = await js.consumers.get("stream", "test");
const c = await js.consumers.get("stream");

const iter = await c.consume({ max_messages: 100 });
for await (const m of iter) {
  console.log(m.seq);
  // m.ack();
}

await nc.close();
