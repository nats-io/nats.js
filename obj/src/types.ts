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
  PubAck,
  PurgeResponse,
  StorageType,
  StreamInfo,
  StreamInfoRequestOptions,
} from "@nats-io/jetstream";

import type { MsgHdrs, Nanos, QueuedIterator } from "@nats-io/nats-core";

export type { Placement } from "@nats-io/jetstream";
export { StorageType } from "@nats-io/jetstream";

export type ObjectStoreLink = {
  /**
   * name of object store storing the data
   */
  bucket: string;
  /**
   * link to single object, when empty this means the whole store
   */
  name?: string;
};
export type ObjectStoreMetaOptions = {
  /**
   * If set, the object is a reference to another entry.
   */
  link?: ObjectStoreLink;
  /**
   * The maximum size in bytes for each chunk.
   * Note that if the size exceeds the maximum size of a stream
   * entry, the number will be clamped to the streams maximum.
   */
  max_chunk_size?: number;
};
export type ObjectStoreMeta = {
  name: string;
  description?: string;
  headers?: MsgHdrs;
  options?: ObjectStoreMetaOptions;
  metadata?: Record<string, string>;
};

export type ObjectWatchInfo = ObjectInfo & {
  isUpdate: boolean;
};

export type ObjectInfo = ObjectStoreMeta & {
  /**
   * The name of the bucket where the object is stored.
   */
  bucket: string;
  /**
   * The current ID of the entries holding the data for the object.
   */
  nuid: string;
  /**
   * The size in bytes of the object.
   */
  size: number;
  /**
   * The number of entries storing the object.
   */
  chunks: number;
  /**
   * A cryptographic checksum of the data as a whole.
   */
  digest: string;
  /**
   * True if the object was deleted.
   */
  deleted: boolean;
  /**
   * An UTC timestamp
   */
  mtime: string;
  /**
   * The revision number for the entry
   */
  revision: number;
};

/**
 * A link reference
 */
export type ObjectLink = {
  /**
   * The object store the source data
   */
  bucket: string;
  /**
   * The name of the entry holding the data. If not
   * set it is a complete object store reference.
   */
  name?: string;
};

export type ObjectStoreStatus = {
  /**
   * The bucket name
   */
  bucket: string;
  /**
   * the description associated with the object store.
   */
  description: string;
  /**
   * The time to live for entries in the object store in nanoseconds.
   * Convert to millis using the `millis()` function.
   */
  ttl: Nanos;
  /**
   * The object store's underlying stream storage type.
   */
  storage: StorageType;
  /**
   * The number of replicas associated with this object store.
   */
  replicas: number;
  /**
   * Set to true if the object store is sealed and will reject edits.
   */
  sealed: boolean;
  /**
   * The size in bytes that the object store occupies.
   */
  size: number;
  /**
   * The underlying storage for the object store. Currently, this always
   * returns "JetStream".
   */
  backingStore: string;
  /**
   * The StreamInfo backing up the ObjectStore
   */
  streamInfo: StreamInfo;
  /**
   * Metadata the object store. Note that
   * keys starting with `_nats` are reserved. This feature only supported on servers
   * 2.10.x and better.
   */
  metadata?: Record<string, string> | undefined;
  /**
   * Compression level of the stream. This feature is only supported in
   * servers 2.10.x and better.
   */
  compression: boolean;
};

export type ObjectStoreOptions = {
  /**
   * A description for the object store
   */
  description?: string;
  /**
   * The time to live for entries in the object store specified
   * as nanoseconds. Use the `nanos()` function to convert millis to
   * nanos.
   */
  ttl?: Nanos;
  /**
   * The underlying stream storage type for the object store.
   */
  storage: StorageType;
  /**
   * The number of replicas to create.
   */
  replicas: number;
  /**
   * The maximum amount of data that the object store should store in bytes.
   */
  "max_bytes": number;
  /**
   * Placement hints for the underlying object store stream
   */
  placement: Placement; /**
   * Metadata field to store additional information about the stream. Note that
   * keys starting with `_nats` are reserved. This feature only supported on servers
   * 2.10.x and better.
   */
  metadata?: Record<string, string>;
  /**
   * Sets the compression level of the stream. This feature is only supported in
   * servers 2.10.x and better.
   */
  compression?: boolean;
};
/**
 * An object that allows reading the object stored under a specified name.
 */
export type ObjectResult = {
  /**
   * The info of the object that was retrieved.
   */
  info: ObjectInfo;
  /**
   * The readable stream where you can read the data.
   */
  data: ReadableStream<Uint8Array>;
  /**
   * A promise that will resolve to an error if the readable stream failed
   * to process the entire response. Should be checked when the readable stream
   * has finished yielding data.
   */
  error: Promise<Error | null>;
};
export type ObjectStorePutOpts = {
  /**
   * maximum number of millis for the put requests to succeed
   */
  timeout?: number;
  /**
   * If set the ObjectStore must be at the current sequence or the
   * put will fail. Note the sequence accounts where the metadata
   * for the entry is stored.
   */
  previousRevision?: number;
};

export type ObjectStore = {
  /**
   * Returns the ObjectInfo of the named entry. Or null if the
   * entry doesn't exist.
   * @param name
   */
  info(name: string): Promise<ObjectInfo | null>;

  /**
   * Returns a list of the entries in the ObjectStore
   */
  list(): Promise<ObjectInfo[]>;

  /**
   * Returns an object you can use for reading the data from the
   * named stored object or null if the entry doesn't exist.
   * @param name
   */
  get(name: string): Promise<ObjectResult | null>;

  /**
   * Returns the data stored for the named entry.
   * @param name
   */
  getBlob(name: string): Promise<Uint8Array | null>;

  /**
   * Adds an object to the store with the specified meta
   * and using the specified ReadableStream to stream the data.
   * @param meta
   * @param rs
   * @param opts
   */
  put(
    meta: ObjectStoreMeta,
    rs: ReadableStream<Uint8Array>,
    opts?: ObjectStorePutOpts,
  ): Promise<ObjectInfo>;

  /**
   * Puts the specified bytes into the store with the specified meta.
   * @param meta
   * @param data
   * @param opts
   */
  putBlob(
    meta: ObjectStoreMeta,
    data: Uint8Array | null,
    opts?: ObjectStorePutOpts,
  ): Promise<ObjectInfo>;

  /**
   * Deletes the specified entry from the object store.
   * @param name
   */
  delete(name: string): Promise<PurgeResponse>;

  /**
   * Adds a link to another object in the same store or a different one.
   * Note that links of links are rejected.
   * object.
   * @param name
   * @param meta
   */
  link(name: string, meta: ObjectInfo): Promise<ObjectInfo>;

  /**
   * Add a link to another object store
   * @param name
   * @param bucket
   */
  linkStore(name: string, bucket: ObjectStore): Promise<ObjectInfo>;

  /**
   * Watch an object store and receive updates of modifications via
   * an iterator.
   * @param opts
   */
  watch(
    opts?: Partial<
      {
        ignoreDeletes?: boolean;
        includeHistory?: boolean;
      }
    >,
  ): Promise<QueuedIterator<ObjectWatchInfo>>;

  /**
   * Seals the object store preventing any further modifications.
   */
  seal(): Promise<ObjectStoreStatus>;

  /**
   * Returns the runtime status of the object store.
   * @param opts
   */
  status(opts?: Partial<StreamInfoRequestOptions>): Promise<ObjectStoreStatus>;

  /**
   * Update the metadata for an object. If the name is modified, the object
   * is effectively renamed and will only be accessible by its new name.
   * @param name
   * @param meta
   */
  update(name: string, meta: Partial<ObjectStoreMeta>): Promise<PubAck>;

  /**
   * Destroys the object store and all its entries.
   */
  destroy(): Promise<boolean>;
};
