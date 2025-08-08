/*
 * Copyright 2023-2024 The NATS Authors
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
import type {
  Placement,
  Republish,
  StorageType,
  StreamInfo,
  StreamSource,
} from "@nats-io/jetstream";
import type { Payload, QueuedIterator } from "@nats-io/nats-core";

export type KvEntry = {
  bucket: string;
  key: string;
  value: Uint8Array;
  created: Date;
  revision: number;
  delta?: number;
  operation: "PUT" | "DEL" | "PURGE";
  length: number;
  rawKey: string;

  /**
   * Convenience method to parse the entry payload as JSON. This method
   * will throw an exception if there's a parsing error;
   */
  json<T>(): T;

  /**
   * Convenience method to parse the entry payload as string. This method
   * may throw an exception if there's a conversion error
   */
  string(): string;
};

export type KvWatchEntry = KvEntry & {
  isUpdate: boolean;
};

/**
 * A key codec is used to encode and decode keys before they are stored
 * or returned to the client in a Key-Value store.
 *
 * The codec transforms each token (part between dots) in a key string, allowing
 * for custom encoding/decoding while preserving the hierarchical structure of NATS subjects.
 *
 * ## Purpose
 * - Enables custom encoding of keys (e.g., base64, encryption, or custom mappings)
 * - Preserves the ability to use NATS subject wildcards for filtering
 * - Ensures proper storage and retrieval of keys with special characters
 *
 * ## Requirements
 * 1. Must preserve the dot-delimited structure of NATS subjects
 * 2. Must handle wildcard tokens (`*` and `>`) without modification
 * 3. Must be able to properly encode/decode each token independently
 * 4. Must be deterministic (same input always produces same output)
 *
 * ## Example
 * ```
 * // Original key: "users.john.profile"
 * // Encoded key: "dXNlcnM=.am9obg==.cHJvZmlsZQ=="
 *
 * // With wildcards (these remain unchanged):
 * // Original key: "users.*.profile"
 * // Encoded key: "dXNlcnM=.*.cHJvZmlsZQ=="
 * ```
 *
 * Note: This codec is specifically for subject-compatible transformations of keys,
 * not for general data transformation or serialization. It operates at the token level
 * to preserve NATS subject semantics, ensuring that filtering, watches, and other
 * subject-based operations continue to work properly.
 */

export type KvKeyCodec = {
  /**
   * Encodes a key or key token before storage
   */
  encode(k: string): string;
  /**
   * Decodes a key or key token after retrieval
   */
  decode(k: string): string;
};

/**
 * @deprecated
 */
export type KvCodec<T> = {
  encode(k: T): T;
  decode(k: T): T;
};

/**
 * A payload codec for transforming data before storage and after retrieval in a Key-Value store.
 *
 * ## Purpose
 * The KvPayloadCodec handles the transformation of values between the application layer and
 * the storage layer in the NATS Key-Value store. All values in NATS KV are ultimately stored
 * as binary data (Uint8Array), and this codec provides a way to customize how data is
 * encoded/decoded.
 *
 * ## Data Flow
 * 1. When storing: Application data (string or Uint8Array) → encode() → Uint8Array (stored in NATS)
 * 2. When retrieving: Uint8Array (from NATS) → decode() → Uint8Array (returned to application)
 *
 * ## Important Notes
 * - The codec always returns Uint8Array, but KvEntry provides convenience methods (string(), json())
 *   for parsing the binary data into other formats
 * - Even when the input is a string, the codec must convert it to and work with Uint8Array
 * - The decode method must always return a Uint8Array, even if your application uses string values
 * - Custom codecs can implement compression, encryption, or other transformations
 *
 * ## Example Use Cases
 * - Compression: Reduce the size of stored data
 * - Encryption: Secure sensitive data at rest
 *
 * @example
 * ```typescript
 * // Simple compression codec using a hypothetical compression library
 * const CompressionCodec = (): KvPayloadCodec => {
 *   return {
 *     encode(v: Payload): Uint8Array {
 *       // Convert string to Uint8Array if needed
 *       const data = typeof v === "string" ? new TextEncoder().encode(v) : v;
 *       // Apply compression
 *       return compressData(data);
 *     },
 *     decode(d: Uint8Array): Uint8Array {
 *       // Decompress the data
 *       return decompressData(d);
 *     }
 *   };
 * };
 * ```
 */
export type KvPayloadCodec = {
  encode(v: Payload): Uint8Array;
  decode(d: Uint8Array): Uint8Array;
};

/**
 * A KvCodecs object contains two codecs: one for keys and one for values.
 * These codecs are used to encode and decode keys and values before they are stored
 * or retrieved from the KV.
 */
export type KvCodecs = {
  /**
   * Codec for Keys in the KV
   */
  key: KvKeyCodec;
  /**
   * Codec for Data in the KV
   */
  value: KvPayloadCodec;
};

export type KvLimits = {
  /**
   * Sets the specified description on the stream of the KV.
   */
  description: string;
  /**
   * Number of replicas for the KV (1,3,or 5).
   */
  replicas: number;
  /**
   * Number of maximum messages allowed per subject (key).
   */
  history: number;
  /**
   * The maximum number of bytes on the KV
   */
  max_bytes: number;

  /**
   * The maximum size of a value on the KV
   */
  maxValueSize: number;
  /**
   * The maximum number of millis the key should live
   * in the KV. The server will automatically remove
   * keys older than this amount. Note that deletion of
   * delete markers are not performed.
   */
  ttl: number; // millis
  /**
   * When set, this will turn on the stream's `allow_msg_ttl`, and
   * set the `subject_delete_marker_ttl` to the specified number of
   * milliseconds. Note that while you can change this setting, you
   * cannot make it 0 once set as the `allow_msg_ttl` cannot be disabled once set.
   */
  markerTTL: number; // millis
  /**
   * The backing store of the stream hosting the KV
   */
  storage: StorageType;
  /**
   * Placement hints for the stream hosting the KV
   */
  placement: Placement;
  /**
   * Republishes edits to the KV on a NATS core subject.
   */
  republish: Republish;
  /**
   * Maintains a 1:1 mirror of another kv stream with name matching this property.
   */
  mirror?: StreamSource;
  /**
   * List of Stream names to replicate into this KV
   */
  sources?: StreamSource[];

  /**
   * Sets the compression level of the KV. This feature is only supported in
   * servers 2.10.x and better.
   */
  compression?: boolean;
};

export type KvStatus = KvLimits & {
  /**
   * The simple name for a Kv - this name is typically prefixed by `KV_`.
   */
  bucket: string;
  /**
   * Number of entries in the KV
   */
  values: number;

  /**
   * The StreamInfo backing up the KV
   */
  streamInfo: StreamInfo;

  /**
   * Size of the bucket in bytes
   */
  size: number;
  /**
   * Metadata field to store additional information about the stream. Note that
   * keys starting with `_nats` are reserved. This feature only supported on servers
   * 2.10.x and better.
   */
  metadata?: Record<string, string>;

  /**
   * Number of millis delete markers will live before they are removed by the server.
   * Note that this value will be set to 0 if the underlying stream doesn't enable
   * this feature. This is a feature that must be configured on bucket creation.
   */
  markerTTL: number;
};

export type KvOptions = KvLimits & {
  /**
   * How long to wait in milliseconds for a response from the KV
   */
  timeout: number;
  /**
   * The underlying stream name for the KV
   */
  streamName: string;
  /**
   * An encoder/decoder for keys and values
   */
  codec: KvCodecs;
  /**
   * Doesn't attempt to create the KV stream if it doesn't exist.
   */
  bindOnly: boolean;
  /**
   * If true and on a recent server, changes the way the KV
   * retrieves values. This option is significantly faster,
   * but has the possibility of inconsistency during a read.
   */
  allow_direct: boolean;
  /**
   * Metadata field to store additional information about the kv. Note that
   * keys starting with `_nats` are reserved. This feature only supported on servers
   * 2.10.x and better.
   */
  metadata?: Record<string, string>;
};

export const KvWatchInclude = {
  /**
   * Include the last value for all the keys
   */
  LastValue: "",
  /**
   * Include all available history for all keys
   */
  AllHistory: "history",
  /**
   * Don't include history or last values, only notify
   * of updates
   */
  UpdatesOnly: "updates",
} as const;
export type KvWatchInclude = typeof KvWatchInclude[keyof typeof KvWatchInclude];

export type KvWatchOptions = {
  /**
   * A key or wildcarded key following keys as if they were NATS subject names.
   * Note you can specify multiple keys if running on server 2.10.x or better.
   */
  key?: string | string[];
  /**
   * Notification should only include entry headers
   */
  headers_only?: boolean;
  /**
   * Skips notifying deletes.
   * @default: false
   */
  ignoreDeletes?: boolean;
  /**
   * Specify what to include in the watcher, by default all last values.
   */
  include?: KvWatchInclude;
  /**
   * Starts watching at the specified revision. This is intended for watchers
   * that have restarted watching and have maintained some state of where they are
   * in the watch.
   */
  resumeFromRevision?: number;
};

export type RoKV = {
  /**
   * Returns the KvEntry stored under the key if it exists or null if not.
   * Note that the entry returned could be marked with a "DEL" or "PURGE"
   * operation which signifies the server stored the value, but it is now
   * deleted.
   * @param k
   * @param opts
   */
  get(k: string, opts?: { revision: number }): Promise<KvEntry | null>;

  /**
   * Returns an iterator of the specified key's history (or all keys).
   * Note you can specify multiple keys if running on server 2.10.x or better.
   * @param opts
   */
  history(
    opts?: { key?: string | string[] },
  ): Promise<QueuedIterator<KvWatchEntry>>;

  /**
   * Returns an iterator that will yield KvEntry updates as they happen.
   * @param opts
   */
  watch(
    opts?: KvWatchOptions,
  ): Promise<QueuedIterator<KvWatchEntry>>;

  /**
   * Returns information about the Kv
   */
  status(): Promise<KvStatus>;

  /**
   * Returns an iterator of all the keys optionally matching
   * the specified filter.
   * @param filter - default is all keys
   */
  keys(filter?: string | string[]): Promise<QueuedIterator<string>>;
};

export type KV = RoKV & {
  /**
   * Creates a new entry ensuring that the entry does not exist (or
   * the current version is deleted or the key is purged)
   * If the entry already exists, this operation fails.
   *
   * markerTTL is specified as a [Go duration strings](https://pkg.go.dev/maze.io/x/duration#ParseDuration)
   * ("10s", "1m", "1h"...)
   *
   * @param k
   * @param data
   * @param markerTTL - duration is specified as a string
   */
  create(k: string, data: Payload, markerTTL?: string): Promise<number>;

  /**
   * Updates the existing entry provided that the previous sequence
   * for the Kv is at the specified version. This ensures that the
   * KV has not been modified prior to the update.
   * @param k
   * @param data
   * @param version
   * @param timeout in millis
   */
  update(
    k: string,
    data: Payload,
    version: number,
    timeout?: number,
  ): Promise<number>;

  /**
   * Sets or updates the value stored under the specified key.
   * @param k
   * @param data
   * @param opts
   */
  put(
    k: string,
    data: Payload,
    opts?: Partial<KvPutOptions>,
  ): Promise<number>;

  /**
   * Deletes the entry stored under the specified key.
   * Deletes are soft-deletes. The server will add a new
   * entry marked by a "DEL" operation.
   * Note that if the KV was created with an underlying limit
   * (such as a TTL on keys) it is possible for
   * a key or the soft delete marker to be removed without
   * additional notification on a watch.
   * @param k
   * @param opts
   */
  delete(k: string, opts?: Partial<KvDeleteOptions>): Promise<void>;

  /**
   * Deletes and purges the specified key and any value
   * history.
   * @param k
   * @param opts
   */
  purge(k: string, opts?: Partial<KvPurgeOptions>): Promise<void>;

  /**
   * Destroys the underlying stream used by the KV. This
   * effectively deletes all data stored under the KV.
   */
  destroy(): Promise<boolean>;
};

export type KvPutOptions = {
  /**
   * If set the KV must be at the current sequence or the
   * put will fail.
   */
  previousSeq: number;

  /**
   * Timeout value in milliseconds for the put, overrides Jetstream context's
   * default.
   */
  timeout: number;
};

export type KvPurgeOptions = KvDeleteOptions & {
  /**
   * If set, the entry will notify when deleted after the specified duration.
   * Note that for this option to work, the KvBucket must have the
   * markerTTL option.
   *
   * Note that the duration is specified as a string. The duration format matches
   * [Go duration strings](https://pkg.go.dev/maze.io/x/duration#ParseDuration)
   * - "10s" - 10 seconds
   * - "1m" - 1 minute
   * - "1h" - 1 hour
   *
   * If a unit suffix is not specified, it is assumed to be seconds.
   */
  ttl: string;
};

export type KvDeleteOptions = {
  /**
   * If set the KV must be at the current sequence or the
   * put will fail.
   */
  previousSeq: number;
};

export const kvPrefix = "KV_";
