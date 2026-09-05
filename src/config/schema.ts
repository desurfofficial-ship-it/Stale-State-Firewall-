/**
 * Configuration file schema (spec §33).
 *
 * ssf.config.yaml is security-sensitive configuration (spec §30). Everything
 * in this module describes what MAY appear in the file; config/validation.ts
 * enforces what MUST NOT (unknown fields, dangerous defaults, contradictions,
 * impossible conditions).
 */

import type { FirewallPolicyConfig, RiskDefaultRule, OutcomeDecision } from '../domain/policy.js';
import type { RiskLevel, Precondition } from '../domain/action.js';
import type { StateDependencyInput } from '../domain/state.js';
import type { DecisionType } from '../domain/decision.js';

export interface GlobalDefaultsFile {
  on_unknown?: OutcomeDecision;
  unknown?: OutcomeDecision;
  on_stale?: OutcomeDecision;
  stale?: OutcomeDecision;
  on_invalid?: OutcomeDecision;
  invalid?: OutcomeDecision;
  on_aging?: OutcomeDecision;
  aging?: OutcomeDecision;
  on_fresh?: OutcomeDecision;
  fresh?: OutcomeDecision;
  default_freshness?: FirewallPolicyConfig['freshness'];
  aging_threshold?: number;
  clock_skew_tolerance?: string | number;
  execution_deadline?: string | number;
}

export interface StorageConfigFile {
  type: 'sqlite' | 'memory';
  /** File path for sqlite; special value ":memory:" keeps everything in RAM. */
  path?: string;
}

export interface HttpResourceConfig {
  /** URL template; {id} is replaced with the resource_id. Must be http(s). */
  url: string;
  /** Static request headers. Values may use env(VARNAME) indirection. */
  headers?: Record<string, string>;
  /** Version signal extraction. */
  version?: {
    source: 'header' | 'json_path';
    /** Header name or dot-path into the JSON body. */
    name: string;
  };
  /** Server timestamp extraction for observed_at. */
  observed_at?: {
    source: 'json_path';
    name: string;
    format: 'iso' | 'epoch_s' | 'epoch_ms';
  };
  /** Metadata field extraction: metadata key -> dot-path into the JSON body. */
  metadata_paths?: Record<string, string>;
  /** Hash the canonical JSON body for content-hash freshness. */
  content_hash?: 'body' | 'off';
  /** Timeout in ms (default 5000). */
  timeout_ms?: number;
  /** Explicitly trust the resource supports conditional requests via ETag. */
  conditional?: boolean;
}

export interface GitHubProviderConfigFile {
  enabled?: boolean;
  api_base?: string;
  timeout_ms?: number;
  /** Include pull-request review aggregation when inspecting pull requests. */
  include_reviews?: boolean;
}

export interface ProvidersConfigFile {
  memory?: {
    enabled?: boolean;
    /** Name used as the source identifier (default "memory"). */
    source?: string;
  };
  http?: {
    enabled?: boolean;
    resources?: Record<string, HttpResourceConfig>;
  };
  github?: GitHubProviderConfigFile;
}

/** A single deterministic scenario for `ssf policy test` (spec §66). */
export interface PolicyTestCaseFile {
  name: string;
  action: {
    agent_id?: string;
    tool?: string;
    operation: string;
    target?: string;
    arguments?: Record<string, unknown>;
    dependencies?: StateDependencyInput[];
    preconditions?: Precondition[];
    risk_level?: RiskLevel;
    policy?: string;
  };
  /** Current state fixtures served by the in-memory provider during the test. */
  state: Array<{
    source?: string;
    resource: string;
    resource_id: string;
    version?: string;
    metadata: Record<string, unknown>;
    updated_at?: string;
  }>;
  expect_decision: DecisionType;
  expect_policy?: string;
}

export interface TelemetryConfigFile {
  enabled?: boolean;
}

export interface LoggingConfigFile {
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Redact sensitive keys from logs (default true; disabling is discouraged). */
  redact?: boolean;
}

export interface FirewallRootConfigFile {
  firewall: {
    mode: 'observe' | 'enforce' | 'strict';
    storage?: StorageConfigFile;
    /**
     * Explicit acknowledgment required before on_unknown/on_stale "allow"
     * is accepted anywhere in the configuration (spec §31).
     */
    acknowledge_unknown_allow?: boolean;
  };
  defaults?: GlobalDefaultsFile;
  /** Named policies ("actions" in spec §33 terminology). */
  actions?: FirewallPolicyConfig[];
  /** Optional external policy file (YAML/JSON) with { policies: [...] }. */
  policies_file?: string;
  providers?: ProvidersConfigFile;
  policy_tests?: PolicyTestCaseFile[];
  risk_defaults?: RiskDefaultsConfigFile;
  telemetry?: TelemetryConfigFile;
  logging?: LoggingConfigFile;
}

/** Operation-pattern to risk-level mapping (spec §9). */
export interface RiskDefaultsConfigFile {
  rules?: RiskDefaultRule[];
  default?: RiskLevel;
}

/** External policies file shape. */
export interface PoliciesFile {
  policies: FirewallPolicyConfig[];
  schema_version?: string;
}
