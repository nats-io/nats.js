import { deferred } from "@nats-io/nats-core";
import { join } from "@std/path";

export class Certs {
  #data!: Record<string, string>;
  constructor() {
    this.#data = {};
  }

  list(): string[] {
    const buf = [];
    for (const n in this.#data) {
      buf.push(n);
    }
    return buf;
  }

  /**
   * Loads the certs.json in this package
   */
  static import(): Promise<Certs> {
    const d = deferred<Certs>();
    const certs = new Certs();
    import("./certs.json", { with: { type: "json" } })
      .then((v) => {
        certs.#data = v.default;
        d.resolve(certs);
      })
      .catch((err) => {
        d.reject(err);
      });
    return d;
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
    return Deno.writeTextFile(file, JSON.stringify(this.#data, null, 2));
  }

  /**
   * Stores the certificates in the specified directory
   * @param dir
   */
  store(dir: string): Promise<void> {
    const d = deferred<void>();
    (async () => {
      await Deno.stat(dir).catch(async () => {
        return await Deno.mkdir(dir, { recursive: true });
      });
      for (const n in this.#data) {
        await Deno.writeTextFile(join(dir, n), this.#data[n])
          .catch((err) => {
            d.reject(err);
          });
      }
      d.resolve();
    })();

    return d;
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
  static fromFile(file: string): Promise<Certs> {
    const d = deferred<Certs>();
    const certs = new Certs();
    Deno.readTextFile(file)
      .then((v) => {
        certs.#data = JSON.parse(v);
        d.resolve(certs);
      })
      .catch((err) => {
        d.reject(err);
      });
    return d;
  }

  /**
   * Looks for .crt|.key|.pem files in a directory and returns a Certs
   * @param dir
   */
  static fromDir(dir: string): Promise<Certs> {
    const d = deferred<Certs>();
    const certs = new Certs();
    (async () => {
      const iter = Deno.readDir(dir);
      for await (const e of iter) {
        if (e.isFile) {
          if (
            e.name.endsWith(".crt") ||
            e.name.endsWith(".key") ||
            e.name.endsWith(".pem")
          ) {
            await Deno.readTextFile(join(dir, e.name))
              .then((v) => {
                certs.#data[e.name] = v;
              })
              .catch((err) => {
                d.reject(err);
              });
          }
        }
      }
      let count = 0;
      for (const _ in certs.#data) {
        count++;
        break;
      }
      if (count === 0) {
        d.reject(new Error(`${dir} doesn't contain [crt|key|pem] files`));
      } else {
        d.resolve(certs);
      }
    })();

    return d;
  }
}
