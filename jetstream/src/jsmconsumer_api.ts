/*
 * Copyright 2021-2024 The NATS Authors
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
import { BaseApiClientImpl } from "./jsbaseclient_api.ts";
import { ListerImpl } from "./jslister.ts";
import {
  minValidation,
  validateDurableName,
  validateStreamName,
} from "./jsutil.ts";
import type {
  Nanos,
  NatsConnection,
  NatsConnectionImpl,
} from "@nats-io/nats-core/internal";
import {
  errors,
  Feature,
  InvalidArgumentError,
} from "@nats-io/nats-core/internal";
import type {
  ConsumerApiOptions,
  ConsumerConfig,
  ConsumerCreateOptions,
  ConsumerInfo,
  ConsumerListResponse,
  ConsumerUpdateConfig,
  CreateConsumerRequest,
  PriorityGroups,
  SuccessResponse,
} from "./jsapi_types.ts";
import { ConsumerApiAction, PriorityPolicy } from "./jsapi_types.ts";

import type {
  ConsumerAPI,
  JetStreamOptions,
  Lister,
  ListerFieldFilter,
} from "./types.ts";

export class ConsumerAPIImpl extends BaseApiClientImpl implements ConsumerAPI {
  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    super(nc, opts);
  }

  async addUpdate(
    stream: string,
    cfg: ConsumerConfig,
    opts: ConsumerApiOptions,
  ): Promise<ConsumerInfo> {
    validateStreamName(stream);
    opts = opts || {};

    if (cfg.deliver_group && cfg.flow_control) {
      throw InvalidArgumentError.format(
        ["flow_control", "deliver_group"],
        "are mutually exclusive",
      );
    }
    if (cfg.deliver_group && cfg.idle_heartbeat) {
      throw InvalidArgumentError.format(
        ["idle_heartbeat", "deliver_group"],
        "are mutually exclusive",
      );
    }

    if (isPriorityGroup(cfg)) {
      const { min, ok } = this.nc.features.get(Feature.JS_PRIORITY_GROUPS);
      if (!ok) {
        throw new Error(`priority_groups require server ${min}`);
      }
      if (cfg.deliver_subject) {
        throw InvalidArgumentError.format(
          "deliver_subject",
          "cannot be set when using priority groups",
        );
      }
      validatePriorityGroups(cfg);
    }

    const cr = {} as CreateConsumerRequest;
    cr.config = cfg;
    cr.stream_name = stream;
    cr.action = opts.action || ConsumerApiAction.Create;
    cr.pedantic = opts.pedantic || false;

    if (cr.config.durable_name) {
      validateDurableName(cr.config.durable_name);
    }

    const nci = this.nc as unknown as NatsConnectionImpl;
    let { min, ok: newAPI } = nci.features.get(
      Feature.JS_NEW_CONSUMER_CREATE_API,
    );

    const name = cfg.name === "" ? undefined : cfg.name;
    if (name && !newAPI) {
      throw InvalidArgumentError.format("name", `requires server ${min}`);
    }
    if (name) {
      try {
        minValidation("name", name);
      } catch (err) {
        // if we have a cannot contain the message, massage a bit
        const m = (err as Error).message;
        const idx = m.indexOf("cannot contain");
        if (idx !== -1) {
          throw new Error(`consumer 'name' ${m.substring(idx)}`);
        }
        throw err;
      }
    }

    let subj;
    let consumerName = "";
    // new api doesn't support multiple filter subjects
    // this delayed until here because the consumer in an update could have
    // been created with the new API, and have a `name`
    if (Array.isArray(cfg.filter_subjects)) {
      const { min, ok } = nci.features.get(Feature.JS_MULTIPLE_CONSUMER_FILTER);
      if (!ok) {
        throw InvalidArgumentError.format(
          "filter_subjects",
          `requires server ${min}`,
        );
      }
      newAPI = false;
    }
    if (cfg.metadata) {
      const { min, ok } = nci.features.get(Feature.JS_STREAM_CONSUMER_METADATA);
      if (!ok) {
        throw InvalidArgumentError.format("metadata", `requires server ${min}`);
      }
    }
    if (newAPI) {
      consumerName = cfg.name ?? cfg.durable_name ?? "";
    }
    if (consumerName !== "") {
      let fs = cfg.filter_subject ?? undefined;
      if (fs === ">") {
        fs = undefined;
      }
      subj = fs !== undefined
        ? `${this.prefix}.CONSUMER.CREATE.${stream}.${consumerName}.${fs}`
        : `${this.prefix}.CONSUMER.CREATE.${stream}.${consumerName}`;
    } else {
      subj = cfg.durable_name
        ? `${this.prefix}.CONSUMER.DURABLE.CREATE.${stream}.${cfg.durable_name}`
        : `${this.prefix}.CONSUMER.CREATE.${stream}`;
    }

    const r = await this._request(subj, cr);
    return r as ConsumerInfo;
  }

  add(
    stream: string,
    cfg: ConsumerConfig,
    opts?: ConsumerCreateOptions,
  ): Promise<ConsumerInfo> {
    // in the previous API 3rd arg was a hidden arg, the action - a string
    opts = opts || {};
    let action = ConsumerApiAction.Create;
    if (typeof opts === "string") {
      action = opts;
      opts = {};
    }
    const cco = Object.assign({}, { action }, opts);
    return this.addUpdate(stream, cfg, cco);
  }

  async update(
    stream: string,
    durable: string,
    cfg: ConsumerUpdateConfig,
  ): Promise<ConsumerInfo> {
    const ci = await this.info(stream, durable);
    const changable = cfg as ConsumerConfig;
    return this.addUpdate(
      stream,
      Object.assign(ci.config, changable),
      { action: ConsumerApiAction.Update },
    );
  }

  async info(stream: string, name: string): Promise<ConsumerInfo> {
    validateStreamName(stream);
    validateDurableName(name);
    const r = await this._request(
      `${this.prefix}.CONSUMER.INFO.${stream}.${name}`,
    );
    return r as ConsumerInfo;
  }

  async delete(stream: string, name: string): Promise<boolean> {
    validateStreamName(stream);
    validateDurableName(name);
    const r = await this._request(
      `${this.prefix}.CONSUMER.DELETE.${stream}.${name}`,
    );
    const cr = r as SuccessResponse;
    return cr.success;
  }

  list(stream: string): Lister<ConsumerInfo> {
    validateStreamName(stream);
    const filter: ListerFieldFilter<ConsumerInfo> = (
      v: unknown,
    ): ConsumerInfo[] => {
      const clr = v as ConsumerListResponse;
      return clr.consumers;
    };
    const subj = `${this.prefix}.CONSUMER.LIST.${stream}`;
    return new ListerImpl<ConsumerInfo>(subj, filter, this);
  }

  // Fixme: the API returns the number of nanoseconds, but really should return
  //  millis,
  pause(
    stream: string,
    name: string,
    until: Date,
  ): Promise<{ paused: boolean; pause_until: string; pause_remaining: Nanos }> {
    const subj = `${this.prefix}.CONSUMER.PAUSE.${stream}.${name}`;
    const opts = {
      pause_until: until.toISOString(),
    };
    return this._request(subj, opts) as Promise<
      { paused: boolean; pause_until: string; pause_remaining: Nanos }
    >;
  }

  // Fixme: the API returns the number of nanoseconds, but really should return
  //  millis,
  resume(
    stream: string,
    name: string,
  ): Promise<{ paused: boolean; pause_until?: string }> {
    return this.pause(stream, name, new Date(0)) as Promise<
      { paused: boolean; pause_until?: string; pause_remaining: Nanos }
    >;
  }

  unpin(stream: string, name: string, group: string): Promise<void> {
    const subj = `${this.prefix}.CONSUMER.UNPIN.${stream}.${name}`;
    return this._request(subj, { group }) as Promise<void>;
  }
}

function isPriorityGroup(config: unknown): config is PriorityGroups {
  const pg = config as PriorityGroups;
  return pg && pg.priority_groups !== undefined ||
    pg.priority_policy !== undefined;
}

function validatePriorityGroups(pg: unknown): void {
  if (isPriorityGroup(pg)) {
    if (!Array.isArray(pg.priority_groups)) {
      throw InvalidArgumentError.format(
        ["priority_groups"],
        "must be an array",
      );
    }
    if (pg.priority_groups.length === 0) {
      throw InvalidArgumentError.format(
        ["priority_groups"],
        "must have at least one group",
      );
    }
    pg.priority_groups.forEach((g) => {
      minValidation("priority_group", g);
      if (g.length > 16) {
        throw errors.InvalidArgumentError.format(
          "group",
          "must be 16 characters or less",
        );
      }
    });
    if (
      pg.priority_policy !== PriorityPolicy.None &&
      pg.priority_policy !== PriorityPolicy.Overflow &&
      pg.priority_policy !== PriorityPolicy.PinnedClient
    ) {
      throw InvalidArgumentError.format(
        ["priority_policy"],
        "must be 'none', 'overflow', or 'pinned_client'",
      );
    }
  }
}
