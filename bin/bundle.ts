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
import { cli } from "@aricart/cobra";
import * as esbuild from "esbuild";
// Import the Wasm build on platforms where running subprocesses is not
// permitted, such as Deno Deploy, or when running without `--allow-run`.
// import * as esbuild from "https://deno.land/x/esbuild@0.20.2/wasm.js";

import { denoPlugins } from "@luca/esbuild-deno-loader";

const root = cli({
  use: "bundle javascript/typescript",
  run: async (_cmd, _args, flags) => {
    const src = flags.value<string>("src");
    const out = flags.value<string>("out");

    const result = await esbuild.build({
      plugins: [...denoPlugins()],
      entryPoints: [src],
      outfile: out,
      bundle: true,
      format: "esm",
    });

    console.log(result.outputFiles || out);

    esbuild.stop();
    return 0;
  },
});

root.addFlag({
  name: "src",
  type: "string",
  usage: "input module source path",
  required: true,
});
root.addFlag({
  name: "out",
  type: "string",
  usage: "output bundle path",
  required: true,
});
root.addFlag({
  name: "module",
  type: "boolean",
  usage: "output esm module (default)",
  default: true,
});

Deno.exit(await root.execute(Deno.args));
