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

// Mirrors synadia-labs/testing.go/api/api.go.

export interface CreateServerRequest {
  jetstream: boolean;
  description?: string;
  snippets?: Record<string, string>;
  template?: string;
}

export interface CreateClusterRequest {
  servers: number;
  jetstream: boolean;
  description?: string;
  snippets?: Record<string, string>;
  template?: string;
}

export interface CreateSuperClusterRequest {
  servers: number;
  clusters: number;
  jetstream: boolean;
  description?: string;
  snippets?: Record<string, string>;
  template?: string;
}

export interface ManagedServerInfo {
  name: string;
  cluster: string;
  port: number;
  ports?: Record<string, number>;
  url?: string;
  running: boolean;
}

export interface CreateResponse {
  id: string;
  description?: string;
  kind: string;
  servers: ManagedServerInfo[];
}

export interface DestroyRequest {
  instance_id: string;
}

export interface DestroyResponse {
  destroyed: boolean;
}

export interface InstanceSummary {
  id: string;
  description?: string;
  kind: string;
  cluster?: string;
  servers: number;
  created: string;
}

export interface ListResponse {
  instances: InstanceSummary[];
}

export interface ResetResponse {
  shutdown: boolean;
}

export interface StartServerRequest {
  name: string;
}

export interface StopServerRequest {
  name: string;
}

export interface StopServerResponse {
  shutdown: boolean;
}

// Note: testing.go's api.go tags this `shutdown` (likely an upstream bug);
// we keep the field name `started` here and accept either JSON key when
// decoding.
export interface StartServerResponse {
  started?: boolean;
  shutdown?: boolean;
}

export interface StatusRequest {
  instance_id?: string;
}

export interface InstanceStatus {
  id: string;
  description?: string;
  kind: string;
  servers: ManagedServerInfo[];
}

export interface StatusResponse {
  instances: InstanceStatus[];
}

export const TesterSubjects = {
  createServer: "tester.create.server",
  createCluster: "tester.create.cluster",
  createSuperCluster: "tester.create.super-cluster",
  stopServer: "tester.stop.server",
  startServer: "tester.start.server",
  status: "tester.status",
  list: "tester.list",
  destroy: "tester.destroy",
  reset: "tester.reset",
} as const;
