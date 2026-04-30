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
import { parseArgs } from "@std/cli";
import { ObjectStoreImpl, ServerObjectInfo } from "../obj/src/objectstore.ts";
import { connect, ConnectionOptions, credsAuthenticator } from "nats-deno";

const argv = parseArgs(
  Deno.args,
  {
    alias: {
      "s": ["server"],
      "f": ["creds"],
      "b": ["bucket"],
    },
    default: {
      s: "127.0.0.1:4222",
      c: 1,
      i: 0,
    },
    boolean: ["check"],
    string: ["server", "creds", "bucket"],
  },
);

const copts = { servers: argv.s } as ConnectionOptions;

if (argv.h || argv.help) {
  console.log(
    "Usage: fix-os [-s server] [--creds=/path/file.creds] [--check] --bucket=name",
  );
  console.log(
    "\nThis tool fixes metadata entries in an object store that were written",
  );
  console.log(
    "with base64 encoding without padding. Please backup your object stores",
  );
  console.log("before using this tool.");

  Deno.exit(1);
}

if (argv.creds) {
  const data = await Deno.readFile(argv.creds);
  copts.authenticator = credsAuthenticator(data);
}

if (!argv.bucket) {
  console.log("--bucket is required");
  Deno.exit(1);
}

const nc = await connect(copts);

const js = nc.jetstream();
const jsm = await nc.jetstreamManager();
const lister = jsm.streams.listObjectStores();
let found = false;
const streamName = `OBJ_${argv.bucket}`;
for await (const oss of lister) {
  if (oss.streamInfo.config.name === streamName) {
    found = true;
    break;
  }
}
if (!found) {
  console.log(`bucket '${argv.bucket}' was not found`);
  Deno.exit(1);
}
const os = await js.views.os(argv.bucket) as ObjectStoreImpl;
await fixHashes(os);
await metaFix(os);

async function fixHashes(os: ObjectStoreImpl): Promise<void> {
  let fixes = 0;
  // `$${osPrefix}${os.name}.M.>`
  const osInfo = await os.status({ subjects_filter: "$O.*.M.*" });
  const entries = Object.getOwnPropertyNames(
    osInfo.streamInfo.state.subjects || {},
  );

  for (let i = 0; i < entries.length; i++) {
    const chunks = entries[i].split(".");
    const key = chunks[3];
    if (key.endsWith("=")) {
      // this is already padded
      continue;
    }
    const pad = key.length % 4;
    if (pad === 0) {
      continue;
    }
    // this entry is incorrect fix it
    fixes++;
    if (argv.check) {
      continue;
    }
    const padding = pad > 0 ? "=".repeat(pad) : "";
    chunks[3] += padding;
    const fixedKey = chunks.join(".");

    let m;
    try {
      m = await jsm.streams.getMessage(os.stream, {
        last_by_subj: entries[i],
      });
    } catch (err) {
      console.error(`[ERR] failed to update ${entries[i]}: ${err.message}`);
      continue;
    }
    if (m) {
      try {
        await js.publish(fixedKey, m.data);
      } catch (err) {
        console.error(`[ERR] failed to update ${entries[i]}: ${err.message}`);
        continue;
      }
      try {
        const seq = m.seq;
        await jsm.streams.deleteMessage(os.stream, seq);
      } catch (err) {
        console.error(
          `[WARN] failed to delete bad entry ${
            entries[i]
          }: ${err.message} - new entry was added`,
        );
      }
    }
  }

  const verb = argv.check ? "are" : "were";
  console.log(`${fixes} hash fixes ${verb} required on bucket ${argv.bucket}`);
}

// metaFix addresses an issue where keys that contained `.` were serialized
// using a subject meta that replaced the `.` with `_`.
async function metaFix(os: ObjectStoreImpl): Promise<void> {
  let fixes = 0;
  const osInfo = await os.status({ subjects_filter: "$O.*.M.*" });
  const subjects = Object.getOwnPropertyNames(
    osInfo.streamInfo.state.subjects || {},
  );
  for (let i = 0; i < subjects.length; i++) {
    const metaSubj = subjects[i];
    try {
      const m = await os.jsm.streams.getMessage(os.stream, {
        last_by_subj: metaSubj,
      });
      const soi = m.json<ServerObjectInfo>();
      const calcMeta = os._metaSubject(soi.name);
      if (calcMeta !== metaSubj) {
        fixes++;
        if (argv.check) {
          continue;
        }
        try {
          await js.publish(calcMeta, m.data);
        } catch (err) {
          console.error(`[ERR] failed to update ${metaSubj}: ${err.message}`);
          continue;
        }
        try {
          const seq = m.seq;
          await jsm.streams.deleteMessage(os.stream, seq);
        } catch (err) {
          console.error(
            `[WARN] failed to delete bad entry ${metaSubj}: ${err.message} - new entry was added`,
          );
        }
      }
    } catch (err) {
      console.error(`[ERR] failed to update ${metaSubj}: ${err.message}`);
    }
  }
  const verb = argv.check ? "are" : "were";
  console.log(
    `${fixes} meta fixes ${verb} required on bucket ${argv.bucket}`,
  );
}

await nc.drain();
