/*
 * Copyright 2024 The NATS Authors
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

const {
  deferred,
} = require("@nats-io/nats-core/internal");

exports.check = function check(
  fn,
  timeout = 5000,
  opts = { interval: 50, name: "" },
) {
  opts = Object.assign(opts, { interval: 50 });

  const d = deferred();
  const to = setTimeout(() => {
    clearTimeout(to);
    clearInterval(timer);
    const m = opts.name ? `${opts.name} timeout` : "timeout";
    return d.reject(new Error(m));
  }, timeout);

  const timer = setInterval(async () => {
    try {
      const v = await fn();
      if (v) {
        clearTimeout(to);
        clearInterval(timer);
        return d.resolve(v);
      }
    } catch (_) {
      // ignore
    }
  }, opts.interval);

  return d;
};
