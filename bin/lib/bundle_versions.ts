import { join } from "jsr:@std/path";

export class ModuleVersions {
  file?: SemVer;
  deno?: SemVer;
  node?: SemVer;

  constructor() {
  }

  max(): SemVer | null {
    const vers = this.versions();
    let vv: SemVer | null = null;
    vers.forEach((v) => {
      vv = vv == null ? v : vv.max(v);
    });
    return vv;
  }

  versions(): SemVer[] {
    const vers = [];
    if (this.file) {
      vers.push(this.file);
    }
    if (this.deno) {
      vers.push(this.deno);
    }
    if (this.node) {
      vers.push(this.node);
    }
    return vers;
  }

  check() {
    const m = this.max();
    if (m !== null) {
      this.versions().forEach((v) => {
        if (m.compare(v) !== 0) {
          throw new Error("different versions found");
        }
      });
    }
  }
}

export class SemVer {
  major: number;
  minor: number;
  micro: number;
  qualifier: string;

  constructor(v: string) {
    const m = v.match(/(\d+).(\d+).(\d+)(-{1}(.+))?/);
    if (m) {
      this.major = parseInt(m[1]);
      this.minor = parseInt(m[2]);
      this.micro = parseInt(m[3]);
      this.qualifier = m[5] ? m[5] : "";
    } else {
      throw new Error(`'${v}' is not a semver value`);
    }
  }

  compare(b: SemVer): number {
    if (this.major < b.major) return -1;
    if (this.major > b.major) return 1;
    if (this.minor < b.minor) return -1;
    if (this.minor > b.minor) return 1;
    if (this.micro < b.micro) return -1;
    if (this.micro > b.micro) return 1;
    if (this.qualifier === "") return 1;
    if (b.qualifier === "") return -1;

    // if we have non-empty qualifiers - we expect them to
    const q = parseInt(this.qualifier);
    const qq = parseInt(b.qualifier);

    if (isNaN(q) || isNaN(qq)) {
      return this.qualifier.localeCompare(b.qualifier);
    }
    if (q < qq) return -1;
    if (q > qq) return 1;
    return 0;
  }

  max(b: SemVer): SemVer {
    return this.compare(b) > 0 ? this : b;
  }

  string(): string {
    return `${this.major}.${this.minor}.${this.micro}` +
      (this.qualifier ? `-${this.qualifier}` : "");
  }
}

export async function loadVersionFile(module: string): Promise<string> {
  const { version } = await import(
    join(Deno.cwd(), module, "src", "version.ts")
  ).catch(() => {
    return "";
  });
  return version;
}

export async function loadPackageFile<T = { version: string }>(
  fp: string,
): Promise<T> {
  const src = await Deno.readTextFile(fp)
    .catch(() => {
      return JSON.stringify({});
    });
  return JSON.parse(src);
}

export async function loadVersions(module: string): Promise<ModuleVersions> {
  const v = new ModuleVersions();
  const file = await loadVersionFile(module);
  if (file) {
    v.file = new SemVer(file);
  }

  const { version: deno } = await loadPackageFile(
    join(Deno.cwd(), module, "deno.json"),
  );
  if (deno) {
    v.deno = new SemVer(deno);
  }

  const { version: node } = await loadPackageFile(
    join(Deno.cwd(), module, "package.json"),
  );
  if (node) {
    v.node = new SemVer(node);
  }
  return v;
}
