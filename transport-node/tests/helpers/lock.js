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

/** Creates a lock that resolves when it's lock count reaches 0.
 * If a timeout is provided, the lock rejects if it has not unlocked
 * by the specified number of milliseconds (default 1000).
 */
module.exports.Lock = function lock(count = 1, ms = 5000) {
  let methods;
  const promise = new Promise((resolve, reject) => {
    let timer;
    const cancel = () => {
      if (timer) {
        clearTimeout(timer);
      }
    };

    const lock = () => {
      count++;
    };

    const unlock = () => {
      count--;
      if (count === 0) {
        cancel();
        resolve();
      }
    };

    methods = { resolve, reject, lock, unlock, cancel };
    if (ms) {
      timer = setTimeout(() => {
        reject(new Error("timeout"));
      }, ms);
    }
  });
  return Object.assign(promise, methods);
};
