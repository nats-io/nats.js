import { connect, createInbox, wsconnect } from "../src/mod.ts";
import { assertEquals, assertRejects } from "@std/assert";

Deno.test("basics", () => {
  assertEquals(typeof connect, "function");
  assertEquals(typeof wsconnect, "function");
  assertEquals(typeof createInbox, "function");
});

Deno.test("basics - ws urls fail", async () => {
  await assertRejects(
    () => {
      return connect({ servers: ["ws://localhost:4222"] });
    },
    Error,
    "'servers' deno client doesn't support websockets, use the 'wsconnect' function instead",
  );

  await assertRejects(
    () => {
      return connect({ servers: "ws://localhost:4222" });
    },
    Error,
    "'servers' deno client doesn't support websockets, use the 'wsconnect' function instead",
  );

  await assertRejects(
    () => {
      return connect({ servers: ["wss://localhost:4222"] });
    },
    Error,
    "'servers' deno client doesn't support websockets, use the 'wsconnect' function instead",
  );

  await assertRejects(
    () => {
      return connect({ servers: "wss://localhost:4222" });
    },
    Error,
    "'servers' deno client doesn't support websockets, use the 'wsconnect' function instead",
  );
});
