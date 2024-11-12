/*
 * Copyright 2022-2023 The NATS Authors
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

export type SemVer = { major: number; minor: number; micro: number };
export function parseSemVer(
  s = "",
): SemVer {
  const m = s.match(/(\d+).(\d+).(\d+)/);
  if (m) {
    return {
      major: parseInt(m[1]),
      minor: parseInt(m[2]),
      micro: parseInt(m[3]),
    };
  }
  throw new Error(`'${s}' is not a semver value`);
}
export function compare(a: SemVer, b: SemVer): number {
  if (a.major < b.major) return -1;
  if (a.major > b.major) return 1;
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  if (a.micro < b.micro) return -1;
  if (a.micro > b.micro) return 1;
  return 0;
}

export enum Feature {
  JS_KV = "js_kv",
  JS_OBJECTSTORE = "js_objectstore",
  JS_PULL_MAX_BYTES = "js_pull_max_bytes",
  JS_NEW_CONSUMER_CREATE_API = "js_new_consumer_create",
  JS_ALLOW_DIRECT = "js_allow_direct",
  JS_MULTIPLE_CONSUMER_FILTER = "js_multiple_consumer_filter",
  JS_SIMPLIFICATION = "js_simplification",
  JS_STREAM_CONSUMER_METADATA = "js_stream_consumer_metadata",
  JS_CONSUMER_FILTER_SUBJECTS = "js_consumer_filter_subjects",
  JS_STREAM_FIRST_SEQ = "js_stream_first_seq",
  JS_STREAM_SUBJECT_TRANSFORM = "js_stream_subject_transform",
  JS_STREAM_SOURCE_SUBJECT_TRANSFORM = "js_stream_source_subject_transform",
  JS_STREAM_COMPRESSION = "js_stream_compression",
  JS_DEFAULT_CONSUMER_LIMITS = "js_default_consumer_limits",
  JS_BATCH_DIRECT_GET = "js_batch_direct_get",
  JS_PRIORITY_GROUPS = "js_priority_groups",
}

type FeatureVersion = {
  ok: boolean;
  min: string;
};

export class Features {
  server!: SemVer;
  features: Map<Feature, FeatureVersion>;
  disabled: Feature[];
  constructor(v: SemVer) {
    this.features = new Map<Feature, FeatureVersion>();
    this.disabled = [];
    this.update(v);
  }

  /**
   * Removes all disabled entries
   */
  resetDisabled(): void {
    this.disabled.length = 0;
    this.update(this.server);
  }

  /**
   * Disables a particular feature.
   * @param f
   */
  disable(f: Feature): void {
    this.disabled.push(f);
    this.update(this.server);
  }

  isDisabled(f: Feature): boolean {
    return this.disabled.indexOf(f) !== -1;
  }

  update(v: SemVer | string): void {
    if (typeof v === "string") {
      v = parseSemVer(v);
    }
    this.server = v;
    this.set(Feature.JS_KV, "2.6.2");
    this.set(Feature.JS_OBJECTSTORE, "2.6.3");
    this.set(Feature.JS_PULL_MAX_BYTES, "2.8.3");
    this.set(Feature.JS_NEW_CONSUMER_CREATE_API, "2.9.0");
    this.set(Feature.JS_ALLOW_DIRECT, "2.9.0");
    this.set(Feature.JS_MULTIPLE_CONSUMER_FILTER, "2.10.0");
    this.set(Feature.JS_SIMPLIFICATION, "2.9.4");
    this.set(Feature.JS_STREAM_CONSUMER_METADATA, "2.10.0");
    this.set(Feature.JS_CONSUMER_FILTER_SUBJECTS, "2.10.0");
    this.set(Feature.JS_STREAM_FIRST_SEQ, "2.10.0");
    this.set(Feature.JS_STREAM_SUBJECT_TRANSFORM, "2.10.0");
    this.set(Feature.JS_STREAM_SOURCE_SUBJECT_TRANSFORM, "2.10.0");
    this.set(Feature.JS_STREAM_COMPRESSION, "2.10.0");
    this.set(Feature.JS_DEFAULT_CONSUMER_LIMITS, "2.10.0");
    this.set(Feature.JS_BATCH_DIRECT_GET, "2.11.0");
    this.set(Feature.JS_PRIORITY_GROUPS, "2.11.0");

    this.disabled.forEach((f) => {
      this.features.delete(f);
    });
  }

  /**
   * Register a feature that requires a particular server version.
   * @param f
   * @param requires
   */
  set(f: Feature, requires: string): void {
    this.features.set(f, {
      min: requires,
      ok: compare(this.server, parseSemVer(requires)) >= 0,
    });
  }

  /**
   * Returns whether the feature is available and the min server
   * version that supports it.
   * @param f
   */
  get(f: Feature): FeatureVersion {
    return this.features.get(f) || { min: "unknown", ok: false };
  }

  /**
   * Returns true if the feature is supported
   * @param f
   */
  supports(f: Feature): boolean {
    return this.get(f)?.ok || false;
  }

  /**
   * Returns true if the server is at least the specified version
   * @param v
   */
  require(v: SemVer | string): boolean {
    if (typeof v === "string") {
      v = parseSemVer(v);
    }
    return compare(this.server, v) >= 0;
  }
}
