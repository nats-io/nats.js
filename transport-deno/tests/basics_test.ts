import { connect, createInbox, wsconnect } from "../src/mod.ts";
import { assertEquals } from "jsr:@std/assert";

Deno.test("basics", () => {
  assertEquals(typeof connect, "function");
  assertEquals(typeof wsconnect, "function");
  assertEquals(typeof createInbox, "function");
});
