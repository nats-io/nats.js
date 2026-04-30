/*
 * Copyright 2020-2026 The NATS Authors
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
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class Certs {
  #data!: Record<string, string>;
  constructor() {
    this.#data = {};
  }

  list(): string[] {
    return Object.keys(this.#data);
  }

  /**
   * Loads the certs.json in this package
   */
  static async import(): Promise<Certs> {
    const certs = new Certs();
    const v = await import("./certs.json", { with: { type: "json" } });
    certs.#data = v.default;
    return certs;
  }

  static fromJSON(d: Record<string, string>): Promise<Certs> {
    const certs = new Certs();
    certs.#data = d;
    return Promise.resolve(certs);
  }

  /**
   * Saves the certs into a JSON file
   * @param file
   */
  save(file: string): Promise<void> {
    return writeFile(file, JSON.stringify(this.#data, null, 2), "utf-8");
  }

  /**
   * Stores the certificates in the specified directory
   * @param dir
   */
  async store(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Object.keys(this.#data).map((n) =>
        writeFile(join(dir, n), this.#data[n], "utf-8")
      ),
    );
  }

  get(n: string): Promise<string> {
    if (!this.#data[n]) {
      return Promise.reject(new Error(`cert '${n}' not found`));
    }
    return Promise.resolve(this.#data[n]);
  }

  /**
   * Parses a JSON file as a Certs
   * @param file
   */
  static async fromFile(file: string): Promise<Certs> {
    const certs = new Certs();
    const v = await readFile(file, "utf-8");
    certs.#data = JSON.parse(v);
    return certs;
  }

  /**
   * Looks for .crt|.key|.pem files in a directory and returns a Certs
   * @param dir
   */
  static async fromDir(dir: string): Promise<Certs> {
    const certs = new Certs();
    const entries = await readdir(dir, { withFileTypes: true });
    const matches = entries.filter((e) =>
      e.isFile() &&
      (e.name.endsWith(".crt") || e.name.endsWith(".key") ||
        e.name.endsWith(".pem"))
    );
    const contents = await Promise.all(
      matches.map((e) => readFile(join(dir, e.name), "utf-8")),
    );
    matches.forEach((e, i) => {
      certs.#data[e.name] = contents[i];
    });
    if (Object.keys(certs.#data).length === 0) {
      throw new Error(`${dir} doesn't contain [crt|key|pem] files`);
    }
    return certs;
  }
}
