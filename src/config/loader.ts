/**
 * Configuration loader (spec §33).
 *
 * Loads ssf.config.yaml (YAML or JSON), validates it completely, and resolves
 * it into runtime structures. Loading fails fast: an invalid configuration
 * throws PolicyValidationError before any enforcement begins (spec §76,
 * scenario I).
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  FirewallRootConfigFile,
  PoliciesFile,
} from './schema.js';
import type { FirewallPolicyConfig, RiskDefaultsConfig, OutcomeDecision } from '../domain/policy.js';
import { PolicyValidationError } from '../domain/errors.js';
import { validateConfig, validatePolicyConfig } from './validation.js';
import { normalizeConfigFile, normalizePolicies } from './normalize.js';
import type { ResolvedPolicy, GlobalDefaults, ResolvedDependencyRule } from '../engine/resolved-policy.js';
import { resolveFreshness, resolveExecutionPolicy, buildDefaultFreshness, DEFAULT_MAX_AGE_MS } from '../engine/resolved-policy.js';

function readConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new PolicyValidationError([
      { path: '$', message: `cannot read configuration file "${path}": ${error instanceof Error ? error.message : String(error)}` },
    ]);
  }
  try {
    if (path.endsWith('.json')) {
      return JSON.parse(text);
    }
    return parseYaml(text);
  } catch (error) {
    throw new PolicyValidationError([
      { path: '$', message: `cannot parse configuration file "${path}": ${error instanceof Error ? error.message : String(error)}` },
    ]);
  }
}

export interface LoadedConfig {
  file: FirewallRootConfigFile;
  /** All policies (inline actions + external policies_file), in precedence order. */
  policies: FirewallPolicyConfig[];
  riskDefaults: RiskDefaultsConfig | null;
}

export function loadConfigFile(configPath: string): LoadedConfig {
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  const raw = normalizeConfigFile(readConfigFile(absolute) as FirewallRootConfigFile);

  const violations = validateConfig(raw);
  if (violations.length > 0) {
    throw new PolicyValidationError(violations);
  }

  const file = raw;
  let policies: FirewallPolicyConfig[] = [...(file.actions ?? [])];

  if (file.policies_file !== undefined) {
    const policiesPath = isAbsolute(file.policies_file)
      ? file.policies_file
      : join(dirname(absolute), file.policies_file);
    const policiesRaw = readConfigFile(policiesPath) as PoliciesFile | null;
    if (policiesRaw === null || typeof policiesRaw !== 'object' || !Array.isArray(policiesRaw.policies)) {
      throw new PolicyValidationError([
        { path: '$.policies_file', message: `policies file "${policiesPath}" must contain a "policies" array` },
      ]);
    }
    if (policiesRaw.schema_version !== undefined && policiesRaw.schema_version !== '1') {
      throw new PolicyValidationError([
        { path: 'schema_version', message: `unsupported policy schema version "${policiesRaw.schema_version}"; this build understands "1"` },
      ]);
    }
    const externalViolations: ReturnType<typeof validateConfig> = [];
    policiesRaw.policies.forEach((policy, i) => {
      validatePolicyConfig(`policies[${i}]`, policy, externalViolations);
    });
    if (externalViolations.length > 0) {
      throw new PolicyValidationError(externalViolations);
    }
    policies = [...policies, ...normalizePolicies(policiesRaw.policies)];
  }

  const riskDefaults: RiskDefaultsConfig | null = file.risk_defaults
    ? {
        rules: file.risk_defaults.rules ?? [],
        default: file.risk_defaults.default ?? 'MEDIUM',
      }
    : null;

  return { file, policies, riskDefaults };
}

/** Global defaults resolved for runtime. */
export function resolveGlobalDefaults(file: FirewallRootConfigFile): GlobalDefaults {
  const d = file.defaults ?? {};
  const built = buildDefaultFreshness(
    d.default_freshness
      ? resolveFreshness(d.default_freshness, d.aging_threshold, d.clock_skew_tolerance, 'defaults.default_freshness')
      : undefined,
    d.execution_deadline !== undefined
      ? resolveExecutionPolicy({ deadline: d.execution_deadline, require_fresh_at_execution: true }, 'defaults.execution')
      : undefined,
  );
  const outcome = (a?: OutcomeDecision, b?: OutcomeDecision): OutcomeDecision | null => a ?? b ?? null;
  return {
    outcomes: {
      fresh: outcome(d.on_fresh, d.fresh) ?? 'allow',
      aging: outcome(d.on_aging, d.aging),
      stale: outcome(d.on_stale, d.stale),
      unknown: outcome(d.on_unknown, d.unknown),
      invalid: outcome(d.on_invalid, d.invalid),
    },
    freshness: built.freshness,
    execution: built.execution,
  };
}

/** Converts a validated policy config into its runtime form. */
export function resolvePolicyConfig(policy: FirewallPolicyConfig, declarationIndex: number): ResolvedPolicy {
  const freshnessConfig = policy.freshness ?? { strategy: 'ttl' as const, max_age: DEFAULT_MAX_AGE_MS };
  return {
    name: policy.name,
    description: policy.description ?? null,
    declarationIndex,
    matcher: policy.match,
    declaredRisk: policy.risk ?? null,
    freshness: resolveFreshness(freshnessConfig, undefined, undefined, `policy "${policy.name}".freshness`),
    preconditions: policy.preconditions ?? [],
    requireDependencies: policy.require_dependencies ?? false,
    dependencyRules: (policy.dependency_freshness ?? []).map(
      (rule): ResolvedDependencyRule => ({
        source: rule.source ?? null,
        resource: rule.resource ?? null,
        resourceId: rule.resource_id ?? null,
        freshness: resolveFreshness(rule.freshness, undefined, undefined, `policy "${policy.name}".dependency_freshness`),
      }),
    ),
    outcomes: {
      fresh: policy.on_fresh ?? null,
      aging: policy.on_aging ?? null,
      stale: policy.on_stale ?? null,
      unknown: policy.on_unknown ?? null,
      invalid: policy.on_invalid ?? null,
    },
    execution: resolveExecutionPolicy(policy.execution, `policy "${policy.name}".execution`),
  };
}

