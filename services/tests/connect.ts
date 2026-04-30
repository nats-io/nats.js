import { connect } from "@nats-io/transport-deno";
import { registerConnect } from "../../test_helpers/src/mod.ts";
registerConnect(connect);
export { connect };
