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

// deno-lint-ignore-file no-explicit-any

import { toConf } from "@nats-io/nst";

// Keys the testing.go service owns (assigned at runtime). Stripped from the
// user-supplied conf before serialization. We re-emit them as Go-template
// placeholders so the service fills in real values when rendering.
const SERVICE_OWNED_TOP = new Set([
  "host",
  "port",
  "http",
  "ports_file_dir",
  "server_name",
  "log_file",
  "cluster",
  "gateway",
]);

// Keys inside `jetstream` owned by the service.
const SERVICE_OWNED_JS = new Set(["store_dir", "enabled"]);

// Listener-bearing snippet keys we offload to service-managed ports.
const LISTENER_KEYS: Record<string, string> = {
  websocket: "websocket",
  mqtt: "mqtt",
  leafnodes: "leafnode",
};

export interface TranslatedConf {
  jetstream: boolean;
  template: string;
  snippets: Record<string, string>;
}

export type TopologyKind = "server" | "cluster" | "super-cluster";

export function translate(
  conf: any = {},
  kind: TopologyKind = "server",
): TranslatedConf {
  conf = conf || {};
  const top: Record<string, unknown> = {};
  const snippets: Record<string, string> = {};
  let jetstream = false;
  let jsLimits: Record<string, unknown> | undefined;
  let hasAccounts = false;
  let hasAuth = false;
  let hasSystemAccount = false;
  let hasOperator = false;

  for (const [key, value] of Object.entries(conf)) {
    if (key === "accounts") hasAccounts = true;
    if (key === "authorization") hasAuth = true;
    if (key === "system_account") hasSystemAccount = true;
    if (key === "operator") hasOperator = true;
    if (key === "jetstream") {
      jetstream = !!value;
      if (value && typeof value === "object") {
        const js: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (!SERVICE_OWNED_JS.has(k)) js[k] = v;
        }
        if (Object.keys(js).length) jsLimits = js;
      }
      continue;
    }
    if (SERVICE_OWNED_TOP.has(key)) continue;
    if (key in LISTENER_KEYS) {
      const portKey = LISTENER_KEYS[key];
      // Strip ports the service will fill in; service auto-reserves a port
      // for known listener-snippet keys and exposes it as .Ports.<name>.
      const v = stripPort({ ...(value as any) });
      snippets[portKey] = renderListener(portKey, v);
      continue;
    }
    top[key] = value;
  }

  // operator / resolver / resolver_preload need explicit quoting that toConf
  // doesn't do — emit them directly with quoted string values.
  const rawParts: string[] = [];
  if (top.operator !== undefined) {
    rawParts.push(`operator: ${JSON.stringify(String(top.operator))}`);
    delete top.operator;
  }
  if (top.resolver !== undefined) {
    rawParts.push(`resolver: ${JSON.stringify(String(top.resolver))}`);
    delete top.resolver;
  }
  if (top.resolver_preload !== undefined) {
    const m = top.resolver_preload as Record<string, unknown>;
    rawParts.push("resolver_preload: {");
    for (const [k, v] of Object.entries(m)) {
      rawParts.push(`  ${k}: ${JSON.stringify(String(v))}`);
    }
    rawParts.push("}");
    delete top.resolver_preload;
  }

  const userConfBody = Object.keys(top).length ? toConf(top) : "";
  const userConf = [rawParts.join("\n"), userConfBody]
    .filter((s) => s.length > 0).join("\n");
  const template = buildTemplate({
    kind,
    jetstream,
    userConf,
    jsLimits,
    snippetKeys: Object.keys(snippets),
    addSysAccount: !hasAccounts && !hasAuth && !hasOperator,
    addSystemAccount: !hasSystemAccount && !hasAuth && !hasOperator &&
      !hasAccounts,
  });
  return { jetstream, template, snippets };
}

function stripPort(v: Record<string, unknown>): Record<string, unknown> {
  delete v.port;
  delete v.listen;
  return v;
}

function renderListener(
  block: string,
  body: Record<string, unknown>,
): string {
  const inner = Object.keys(body).length ? toConf(body) : "";
  return `${block} {\n  port: {{ .Ports.${block} }}\n${inner}\n}`;
}

interface BuildTemplateArgs {
  kind: TopologyKind;
  jetstream: boolean;
  userConf: string;
  jsLimits?: Record<string, unknown>;
  snippetKeys: string[];
  addSysAccount: boolean;
  addSystemAccount: boolean;
}

function buildTemplate(args: BuildTemplateArgs): string {
  const parts: string[] = [];
  parts.push(`server_name: {{ .ServerName }}`);
  parts.push(`port: {{ .ClientPort }}`);
  parts.push(`{{ if .LogFile }}log_file: {{ .LogFile }}{{ end }}`);

  for (const k of args.snippetKeys) {
    parts.push(
      `{{ if .Snippets.${k} }}include "{{ .Snippets.${k} }}"{{ end }}`,
    );
  }

  // Add the default $SYS + USERS account so nst-remote can issue
  // $SYS.REQ.SERVER.* monitoring requests and tests that don't override
  // auth can still connect using the default user1/password creds. Skipped
  // when the test supplies its own accounts/authorization — the test owns
  // the auth surface in that case.
  if (args.addSysAccount) {
    parts.push("");
    parts.push(
      `accounts {\n  USERS { users = [ { user: "user1", pass: "password" } ] }\n  $SYS { users = [ { user: "system", pass: "password" } ] }\n}`,
    );
    parts.push(`no_auth_user: user1`);
  }
  if (args.addSystemAccount) {
    parts.push(`system_account: "$SYS"`);
  }

  if (args.userConf) {
    parts.push("");
    parts.push(args.userConf);
  }

  if (args.jetstream) {
    parts.push("");
    parts.push("jetstream {");
    parts.push("  enabled: true");
    parts.push("  store_dir: {{ .StoreDir }}");
    if (args.jsLimits) {
      for (const [k, v] of Object.entries(args.jsLimits)) {
        parts.push(`  ${k}: ${jsonValue(v)}`);
      }
    }
    parts.push("}");
  }

  if (args.kind === "cluster" || args.kind === "super-cluster") {
    parts.push("");
    parts.push(
      `{{ if and .ClusterName .Routes }}cluster {`,
    );
    parts.push(`  name: {{ .ClusterName }}`);
    parts.push(`  port: {{ .ClusterPort }}`);
    parts.push(`  routes: [`);
    parts.push(`{{ range .Routes }}    nats://{{ . }}`);
    parts.push(`{{ end }}  ]`);
    parts.push(`}{{ end }}`);
  }

  if (args.kind === "super-cluster") {
    parts.push("");
    parts.push(
      `{{ if and .Gateways .GatewayPort .ClusterName }}gateway {`,
    );
    parts.push(`  name: {{ .ClusterName }}`);
    parts.push(`  port: {{ .GatewayPort }}`);
    parts.push(`  gateways: [`);
    parts.push(
      `{{ range $cluster, $urls := .Gateways }}    { name: "{{ $cluster }}", urls: [{{ range $urls }}"nats://{{ . }}",{{ end }}] }`,
    );
    parts.push(`{{ end }}  ]`);
    parts.push(`}{{ end }}`);
  }

  return parts.join("\n");
}

function jsonValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
