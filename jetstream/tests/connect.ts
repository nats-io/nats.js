import { connect } from "@nats-io/transport-deno";
import { registerConnect } from "../../nst/src/mod.ts";
registerConnect(connect);
export { connect };
