// import the connect function from a transport
import { connect, errors } from "@nats-io/transport-deno";

// connect to NATS demo server
const nc = await connect({ servers: "demo.nats.io:4222" });

// NATS-DOC-START
// Request with custom timeout
try {
  const response = await nc.request("service", "data", { timeout: 2000 });
  console.log(`Response: ${response.string()}`);
} catch (err) {
  if (err instanceof Error) {
    if (err.cause instanceof errors.TimeoutError) {
      console.log(`Response not received in time: ${(err.cause as Error)?.message}`, );
    } else if (err.cause instanceof errors.NoRespondersError) {
      console.log(`No services available to handle request: ${(err.cause as Error)?.message}`, );
    } else {
      console.log(
          `failed due to unknown error: ${(err.cause as Error)?.message}`,
      );
    }
  } else {
    console.log(`request failed: ${err}`);
  }
}
// NATS-DOC-END

await nc.drain();
