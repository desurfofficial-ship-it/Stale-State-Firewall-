/**
 * Configuration and policy validation (spec §30, §31, §66, §76 scenario I).
 *
 * Validation is fail-fast and total: syntax, schema, unknown fields,
 * dangerous defaults, contradictory rules, and impossible conditions are all
 * rejected BEFORE enforcement begins. A malformed policy never reaches the
 * decision engine.
 */

import type {
  FirewallPolicyConfig,
  RiskDefaultRule,
} from '../domain/policy.js';
import { FRESHNESS_STRATEGIES, OUTCOME_DECISIONS } from '../domain/policy.js';
import type { PolicyViolation } from '../domain/errors.js';
import type {
  FirewallRootConfigFile,
  GlobalDefaultsFile,
  ProvidersConfigFile,
} from './schema.js';
import { RISK_LEVELS, PRECONDITION_OPERATORS } from '../domain/action.js';
import type { Precondition as PreconditionConfig } from '../domain/action.js';
import type { DecisionType } from '../domain/decision.js';
import { DECISION_TYPES } from '../domain/decision.js';
import { parseDurationMs } from '../engine/duration.js';

import type { RiskLevel } from '../domain/action.js';

function v(path: string, message: string): PolicyViolation {
  return { path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ROOT_KEYS = new Set([
  'firewall',
  'defaults',
  'actions',
  'policies_file',
  'providers',
  'policy_tests',
  'risk_defaults',
  'telemetry',
  'logging',
]);

const FIREWALL_KEYS = new Set(['mode', 'storage', 'acknowledge_unknown_allow']);
const STORAGE_KEYS = new Set(['type', 'path']);
const DEFAULTS_KEYS = new Set([
  'on_unknown', 'unknown',
  'on_stale', 'stale',
  'on_invalid', 'invalid',
  'on_aging', 'aging',
  'on_fresh', 'fresh',
  'default_freshness',
  'aging_threshold',
  'clock_skew_tolerance',
  'execution_deadline',
]);
const POLICY_KEYS = new Set([
  'name', 'description', 'match', 'risk', 'freshness', 'preconditions',
  'require_dependencies', 'dependency_freshness', 'on_fresh', 'on_aging',
  'on_stale', 'on_unknown', 'on_invalid', 'execution',
]);
const MATCHER_KEYS = new Set(['tool', 'operation', 'target', 'risk']);
const FRESHNESS_KEYS = new Set(['strategy', 'max_age', 'aging_threshold', 'clock_skew_tolerance', 'hybrid']);
const HYBRID_KEYS = new Set(['ttl', 'version', 'hash', 'preconditions']);
const EXECUTION_KEYS = new Set(['deadline', 'require_fresh_at_execution', 'allow_idempotent_retry']);
const DEP_RULE_KEYS = new Set(['source', 'resource', 'resource_id', 'freshness']);
const PROVIDERS_KEYS = new Set(['memory', 'http', 'github']);
const MEMORY_KEYS = new Set(['enabled', 'source']);
const HTTP_KEYS = new Set(['enabled', 'resources']);
const HTTP_RESOURCE_KEYS = new Set([
  'url', 'headers', 'version', 'observed_at', 'metadata_paths',
  'content_hash', 'timeout_ms', 'conditional',
]);
const GITHUB_KEYS = new Set(['enabled', 'api_base', 'timeout_ms', 'include_reviews']);
const RISK_DEFAULTS_KEYS = new Set(['rules', 'default']);
const TEST_KEYS = new Set(['name', 'action', 'state', 'expect_decision', 'expect_policy']);
const TEST_ACTION_KEYS = new Set([
  'agent_id', 'tool', 'operation', 'target', 'arguments',
  'dependencies', 'preconditions', 'risk_level', 'policy',
]);
const DEPENDENCY_KEYS = new Set(['source', 'resource', 'resource_id', 'version', 'content_hash', 'observed_at', 'metadata']);
const PRECONDITION_KEYS = new Set(['field', 'operator', 'value', 'dependency']);

function unknownKeys(path: string, value: unknown, allowed: Set<string>, out: PolicyViolation[]): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      out.push(v(`${path}.${key}`, `unknown field "${key}"`));
    }
  }
}

function checkOutcome(path: string, value: unknown, out: PolicyViolation[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !OUTCOME_DECISIONS.includes(value as never)) {
    out.push(v(path, `expected one of ${OUTCOME_DECISIONS.join('|')}, got ${JSON.stringify(value)}`));
  }
}

function checkRisk(path: string, value: unknown, out: PolicyViolation[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !RISK_LEVELS.includes(value as never)) {
    out.push(v(path, `expected one of ${RISK_LEVELS.join('|')}, got ${JSON.stringify(value)}`));
  }
}

function checkDuration(path: string, value: unknown, out: PolicyViolation[]): void {
  if (value === undefined) return;
  try {
    parseDurationMs(value as string | number, path);
  } catch (error) {
    out.push(v(path, error instanceof Error ? error.message : String(error)));
  }
}

function checkPrecondition(path: string, p: unknown, out: PolicyViolation[]): void {
  if (!isRecord(p)) {
    out.push(v(path, 'precondition must be an object'));
    return;
  }
  unknownKeys(path, p, PRECONDITION_KEYS, out);
  if (typeof p['field'] !== 'string' || p['field'].length === 0) {
    out.push(v(`${path}.field`, 'precondition field is required'));
  }
  if (p['dependency'] !== undefined && (typeof p['dependency'] !== 'string' || p['dependency'].length === 0)) {
    out.push(v(`${path}.dependency`, 'dependency routing pattern must be a non-empty string glob'));
  }
  const operator = p['operator'];
  if (typeof operator !== 'string' || !PRECONDITION_OPERATORS.includes(operator as never)) {
    out.push(v(`${path}.operator`, `expected one of ${PRECONDITION_OPERATORS.join('|')}, got ${JSON.stringify(operator)}`));
    return;
  }
  if (operator === 'exists' || operator === 'not_exists') {
    if ('value' in p) {
      out.push(v(`${path}.value`, `operator "${operator}" takes no value`));
    }
    return;
  }
  if (!('value' in p)) {
    out.push(v(`${path}.value`, `operator "${operator}" requires a value`));
    return;
  }
  const value = p['value'];
  if (operator === 'greater_than' || operator === 'less_than') {
    if (typeof value !== 'number') {
      out.push(v(`${path}.value`, `operator "${operator}" requires a numeric value — a string comparison would be an impossible condition`));
    }
  }
  if (operator === 'matches') {
    if (typeof value !== 'string') {
      out.push(v(`${path}.value`, 'operator "matches" requires a string regex pattern'));
    } else {
      try {
        new RegExp(value, 's');
      } catch (error) {
        out.push(v(`${path}.value`, `invalid regex: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }
  if (operator === 'in' || operator === 'not_in') {
    if (!Array.isArray(value)) {
      out.push(v(`${path}.value`, `operator "${operator}" requires an array value`));
    }
  }
}

export function validateFreshnessConfig(path: string, f: unknown, out: PolicyViolation[]): void {
  if (f === undefined) return;
  if (!isRecord(f)) {
    out.push(v(path, 'freshness must be an object'));
    return;
  }
  unknownKeys(path, f, FRESHNESS_KEYS, out);
  const strategy = f['strategy'];
  if (typeof strategy !== 'string' || !FRESHNESS_STRATEGIES.includes(strategy as never)) {
    out.push(v(`${path}.strategy`, `expected one of ${FRESHNESS_STRATEGIES.join('|')}, got ${JSON.stringify(strategy)}`));
    return;
  }
  if (strategy === 'ttl') {
    if (f['max_age'] === undefined) {
      out.push(v(`${path}.max_age`, 'strategy "ttl" requires max_age'));
    }
  } else if (strategy !== 'hybrid' && f['max_age'] !== undefined) {
    out.push(
      v(
        `${path}.max_age`,
        `max_age is only valid for strategy "ttl" or "hybrid"; for "${strategy}" use the hybrid strategy to combine signals`,
      ),
    );
  }
  checkDuration(`${path}.max_age`, f['max_age'], out);
  checkDuration(`${path}.clock_skew_tolerance`, f['clock_skew_tolerance'], out);
  if (f['aging_threshold'] !== undefined) {
    const t = f['aging_threshold'];
    if (typeof t !== 'number' || t <= 0 || t > 1) {
      out.push(v(`${path}.aging_threshold`, 'aging_threshold must be a number in (0, 1]'));
    }
  }
  if (f['hybrid'] !== undefined) {
    const h = f['hybrid'];
    if (!isRecord(h)) {
      out.push(v(`${path}.hybrid`, 'hybrid must be an object'));
    } else {
      unknownKeys(`${path}.hybrid`, h, HYBRID_KEYS, out);
      const anyTrue = ['ttl', 'version', 'hash', 'preconditions'].some((k) => h[k] === true);
      const anyDefined = ['ttl', 'version', 'hash', 'preconditions'].some((k) => k in h);
      if (anyDefined && !anyTrue) {
        out.push(v(`${path}.hybrid`, 'hybrid enables no components; this policy could never establish freshness'));
      }
      if (h['ttl'] === true && f['max_age'] === undefined) {
        out.push(v(`${path}.max_age`, 'hybrid with ttl component requires max_age'));
      }
    }
  }
  if (strategy === 'hybrid' && f['hybrid'] === undefined && f['max_age'] === undefined) {
    out.push(v(`${path}.max_age`, 'hybrid strategy defaults to ttl+version+preconditions and therefore requires max_age'));
  }
}

export function validatePolicyConfig(path: string, policy: unknown, out: PolicyViolation[]): void {
  if (!isRecord(policy)) {
    out.push(v(path, 'policy must be an object'));
    return;
  }
  unknownKeys(path, policy, POLICY_KEYS, out);
  if (typeof policy['name'] !== 'string' || policy['name'].length === 0) {
    out.push(v(`${path}.name`, 'policy name is required'));
  }
  if (!isRecord(policy['match'])) {
    out.push(v(`${path}.match`, 'policy match object is required'));
  } else {
    unknownKeys(`${path}.match`, policy['match'], MATCHER_KEYS, out);
    const m = policy['match'];
    const hasAny = ['tool', 'operation', 'target', 'risk'].some((k) => m[k] !== undefined);
    if (!hasAny) {
      out.push(v(`${path}.match`, 'empty matcher matches every action; name the policy "default" explicitly or narrow the matcher'));
    }
    for (const key of ['tool', 'operation', 'target'] as const) {
      if (m[key] !== undefined && typeof m[key] !== 'string') {
        out.push(v(`${path}.match.${key}`, 'matcher patterns must be strings'));
      }
    }
    checkRisk(`${path}.match.risk`, m['risk'], out);
  }
  checkRisk(`${path}.risk`, policy['risk'], out);
  validateFreshnessConfig(`${path}.freshness`, policy['freshness'], out);
  if (policy['preconditions'] !== undefined) {
    if (!Array.isArray(policy['preconditions'])) {
      out.push(v(`${path}.preconditions`, 'preconditions must be an array'));
    } else {
      policy['preconditions'].forEach((p: unknown, i: number) => checkPrecondition(`${path}.preconditions[${i}]`, p, out));
    }
  }
  if (policy['require_dependencies'] !== undefined && typeof policy['require_dependencies'] !== 'boolean') {
    out.push(v(`${path}.require_dependencies`, 'require_dependencies must be a boolean'));
  }
  if (policy['dependency_freshness'] !== undefined) {
    if (!Array.isArray(policy['dependency_freshness'])) {
      out.push(v(`${path}.dependency_freshness`, 'dependency_freshness must be an array'));
    } else {
      policy['dependency_freshness'].forEach((rule: unknown, i: number) => {
        if (!isRecord(rule)) {
          out.push(v(`${path}.dependency_freshness[${i}]`, 'dependency rule must be an object'));
          return;
        }
        unknownKeys(`${path}.dependency_freshness[${i}]`, rule, DEP_RULE_KEYS, out);
        if (!isRecord(rule['freshness'])) {
          out.push(v(`${path}.dependency_freshness[${i}].freshness`, 'dependency rule requires a freshness object'));
        } else {
          validateFreshnessConfig(`${path}.dependency_freshness[${i}].freshness`, rule['freshness'], out);
        }
      });
    }
  }
  for (const key of ['on_fresh', 'on_aging', 'on_stale', 'on_unknown', 'on_invalid'] as const) {
    checkOutcome(`${path}.${key}`, policy[key], out);
  }
  // Dangerous defaults (spec §31): allowing on proven-invalid or unknown state.
  if (policy['on_invalid'] === 'allow') {
    out.push(v(`${path}.on_invalid`, 'on_invalid: "allow" is forbidden — state has demonstrably changed; use deny, revalidate, or escalate'));
  }
  if (policy['on_unknown'] === 'allow') {
    out.push(v(`${path}.on_unknown`, 'on_unknown: "allow" requires firewall.acknowledge_unknown_allow: true and is rejected for CRITICAL-risk policies'));
  }
  if (policy['execution'] !== undefined) {
    if (!isRecord(policy['execution'])) {
      out.push(v(`${path}.execution`, 'execution must be an object'));
    } else {
      unknownKeys(`${path}.execution`, policy['execution'], EXECUTION_KEYS, out);
      checkDuration(`${path}.execution.deadline`, policy['execution']['deadline'], out);
      for (const key of ['require_fresh_at_execution', 'allow_idempotent_retry'] as const) {
        if (policy['execution'][key] !== undefined && typeof policy['execution'][key] !== 'boolean') {
          out.push(v(`${path}.execution.${key}`, `${key} must be a boolean`));
        }
      }
    }
  }
}

function validateStorage(path: string, storage: unknown, out: PolicyViolation[]): void {
  if (storage === undefined) return;
  if (!isRecord(storage)) {
    out.push(v(path, 'storage must be an object'));
    return;
  }
  unknownKeys(path, storage, STORAGE_KEYS, out);
  const type = storage['type'];
  if (type !== undefined && type !== 'sqlite' && type !== 'memory') {
    out.push(v(`${path}.type`, `expected "sqlite" or "memory", got ${JSON.stringify(type)}`));
  }
  if (storage['path'] !== undefined && typeof storage['path'] !== 'string') {
    out.push(v(`${path}.path`, 'path must be a string'));
  }
}

function checkEnvIndirection(path: string, value: string, out: PolicyViolation[]): void {
  const match = /^env\(([A-Za-z_][A-Za-z0-9_]*)\)$/.exec(value);
  if (!match) return;
  // env() references are validated structurally; resolution happens at runtime.
  if (match[1] === undefined || match[1]!.length === 0) {
    out.push(v(path, 'env() reference must name a variable'));
  }
}

function validateHttpResource(path: string, resource: unknown, out: PolicyViolation[]): void {
  if (!isRecord(resource)) {
    out.push(v(path, 'http resource must be an object'));
    return;
  }
  unknownKeys(path, resource, HTTP_RESOURCE_KEYS, out);
  if (typeof resource['url'] !== 'string' || !/^https?:\/\//.test(resource['url'])) {
    out.push(v(`${path}.url`, 'url is required and must start with http:// or https://'));
  }
  if (resource['headers'] !== undefined) {
    if (!isRecord(resource['headers'])) {
      out.push(v(`${path}.headers`, 'headers must be an object'));
    } else {
      for (const [k, val] of Object.entries(resource['headers'] as Record<string, unknown>)) {
        if (typeof val !== 'string') {
          out.push(v(`${path}.headers.${k}`, 'header values must be strings'));
        } else {
          checkEnvIndirection(`${path}.headers.${k}`, val, out);
        }
      }
    }
  }
  if (resource['version'] !== undefined) {
    if (!isRecord(resource['version'])) {
      out.push(v(`${path}.version`, 'version must be an object'));
    } else {
      const src = resource['version']['source'];
      if (src !== 'header' && src !== 'json_path') {
        out.push(v(`${path}.version.source`, `expected "header" or "json_path", got ${JSON.stringify(src)}`));
      }
      if (typeof resource['version']['name'] !== 'string' || resource['version']['name'].length === 0) {
        out.push(v(`${path}.version.name`, 'version.name is required'));
      }
    }
  }
  if (resource['observed_at'] !== undefined) {
    if (!isRecord(resource['observed_at'])) {
      out.push(v(`${path}.observed_at`, 'observed_at must be an object'));
    } else {
      if (resource['observed_at']['source'] !== 'json_path') {
        out.push(v(`${path}.observed_at.source`, `expected "json_path", got ${JSON.stringify(resource['observed_at']['source'])}`));
      }
      if (typeof resource['observed_at']['name'] !== 'string') {
        out.push(v(`${path}.observed_at.name`, 'observed_at.name is required'));
      }
      const fmt = resource['observed_at']['format'];
      if (fmt !== 'iso' && fmt !== 'epoch_s' && fmt !== 'epoch_ms') {
        out.push(v(`${path}.observed_at.format`, `expected "iso", "epoch_s", or "epoch_ms", got ${JSON.stringify(fmt)}`));
      }
    }
  }
  if (resource['metadata_paths'] !== undefined) {
    if (!isRecord(resource['metadata_paths'])) {
      out.push(v(`${path}.metadata_paths`, 'metadata_paths must be an object'));
    } else {
      for (const [k, val] of Object.entries(resource['metadata_paths'])) {
        if (typeof val !== 'string' || val.length === 0) {
          out.push(v(`${path}.metadata_paths.${k}`, 'metadata path must be a non-empty string'));
        }
      }
    }
  }
  if (resource['content_hash'] !== undefined && resource['content_hash'] !== 'body' && resource['content_hash'] !== 'off') {
    out.push(v(`${path}.content_hash`, `expected "body" or "off", got ${JSON.stringify(resource['content_hash'])}`));
  }
  if (resource['timeout_ms'] !== undefined) {
    checkDuration(`${path}.timeout_ms`, resource['timeout_ms'], out);
  }
}

function validateProviders(path: string, providers: unknown, out: PolicyViolation[]): void {
  if (providers === undefined) return;
  if (!isRecord(providers)) {
    out.push(v(path, 'providers must be an object'));
    return;
  }
  unknownKeys(path, providers, PROVIDERS_KEYS, out);
  const p = providers as ProvidersConfigFile;
  if (p.memory !== undefined) {
    if (!isRecord(p.memory)) {
      out.push(v(`${path}.memory`, 'memory provider config must be an object'));
    } else {
      unknownKeys(`${path}.memory`, p.memory, MEMORY_KEYS, out);
    }
  }
  if (p.http !== undefined) {
    if (!isRecord(p.http)) {
      out.push(v(`${path}.http`, 'http provider config must be an object'));
    } else {
      unknownKeys(`${path}.http`, p.http, HTTP_KEYS, out);
      if (p.http.resources !== undefined) {
        if (!isRecord(p.http.resources)) {
          out.push(v(`${path}.http.resources`, 'resources must be an object'));
        } else {
          for (const [name, resource] of Object.entries(p.http.resources)) {
            validateHttpResource(`${path}.http.resources.${name}`, resource, out);
          }
        }
      }
    }
  }
  if (p.github !== undefined) {
    if (!isRecord(p.github)) {
      out.push(v(`${path}.github`, 'github provider config must be an object'));
    } else {
      unknownKeys(`${path}.github`, p.github, GITHUB_KEYS, out);
      const apiBase = p.github['api_base'];
      if (apiBase !== undefined && (typeof apiBase !== 'string' || !/^https?:\/\//.test(apiBase))) {
        out.push(v(`${path}.github.api_base`, 'api_base must start with http:// or https://'));
      }
      if (p.github['timeout_ms'] !== undefined) {
        checkDuration(`${path}.github.timeout_ms`, p.github['timeout_ms'], out);
      }
    }
  }
}

function validatePolicyTest(path: string, test: unknown, out: PolicyViolation[]): void {
  if (!isRecord(test)) {
    out.push(v(path, 'policy test must be an object'));
    return;
  }
  unknownKeys(path, test, TEST_KEYS, out);
  if (typeof test['name'] !== 'string' || test['name'].length === 0) {
    out.push(v(`${path}.name`, 'test name is required'));
  }
  const decision = test['expect_decision'];
  if (typeof decision !== 'string' || !DECISION_TYPES.includes(decision as DecisionType)) {
    out.push(v(`${path}.expect_decision`, `expected one of ${DECISION_TYPES.join('|')}, got ${JSON.stringify(decision)}`));
  }
  if (!isRecord(test['action'])) {
    out.push(v(`${path}.action`, 'test action is required'));
  } else {
    unknownKeys(`${path}.action`, test['action'], TEST_ACTION_KEYS, out);
    if (typeof test['action']['operation'] !== 'string' || test['action']['operation'].length === 0) {
      out.push(v(`${path}.action.operation`, 'test action operation is required'));
    }
    if (test['action']['dependencies'] !== undefined) {
      if (!Array.isArray(test['action']['dependencies'])) {
        out.push(v(`${path}.action.dependencies`, 'dependencies must be an array'));
      } else {
        test['action']['dependencies'].forEach((dep: unknown, i: number) => {
          if (!isRecord(dep)) {
            out.push(v(`${path}.action.dependencies[${i}]`, 'dependency must be an object'));
            return;
          }
          unknownKeys(`${path}.action.dependencies[${i}]`, dep, DEPENDENCY_KEYS, out);
          for (const key of ['source', 'resource', 'resource_id'] as const) {
            if (typeof dep[key] !== 'string' || (dep[key] as string).length === 0) {
              out.push(v(`${path}.action.dependencies[${i}].${key}`, 'dependency reference field is required'));
            }
          }
        });
      }
    }
    if (test['action']['preconditions'] !== undefined && Array.isArray(test['action']['preconditions'])) {
      test['action']['preconditions'].forEach((p: unknown, i: number) =>
        checkPrecondition(`${path}.action.preconditions[${i}]`, p, out),
      );
    }
  }
  if (!Array.isArray(test['state'])) {
    out.push(v(`${path}.state`, 'test state fixtures are required (array)'));
  } else {
    test['state'].forEach((fixture: unknown, i: number) => {
      if (!isRecord(fixture)) {
        out.push(v(`${path}.state[${i}]`, 'state fixture must be an object'));
        return;
      }
      for (const key of ['resource', 'resource_id'] as const) {
        if (typeof fixture[key] !== 'string' || (fixture[key] as string).length === 0) {
          out.push(v(`${path}.state[${i}].${key}`, 'state fixture reference field is required'));
        }
      }
      if (!isRecord(fixture['metadata'])) {
        out.push(v(`${path}.state[${i}].metadata`, 'state fixture metadata is required'));
      }
    });
  }
}

export interface ValidatedConfigInput {
  config: FirewallRootConfigFile;
}

/**
 * Validates the full configuration. Returns all violations; an empty array
 * means the configuration is acceptable.
 */
export function validateConfig(config: FirewallRootConfigFile): PolicyViolation[] {
  const out: PolicyViolation[] = [];

  unknownKeys('$', config, ROOT_KEYS, out);

  const fw = config.firewall;
  if (!isRecord(fw)) {
    out.push(v('$.firewall', 'firewall section is required'));
    return out;
  }
  unknownKeys('$.firewall', fw, FIREWALL_KEYS, out);
  const mode = fw.mode;
  if (mode !== 'observe' && mode !== 'enforce' && mode !== 'strict') {
    out.push(v('$.firewall.mode', `expected "observe" | "enforce" | "strict", got ${JSON.stringify(mode)}`));
  }
  validateStorage('$.firewall.storage', fw.storage, out);
  if (fw.acknowledge_unknown_allow !== undefined && typeof fw.acknowledge_unknown_allow !== 'boolean') {
    out.push(v('$.firewall.acknowledge_unknown_allow', 'acknowledge_unknown_allow must be a boolean'));
  }

  const defaults = config.defaults;
  if (defaults !== undefined) {
    if (!isRecord(defaults)) {
      out.push(v('$.defaults', 'defaults must be an object'));
    } else {
      unknownKeys('$.defaults', defaults, DEFAULTS_KEYS, out);
      const d = defaults as GlobalDefaultsFile;
      for (const key of ['on_unknown', 'unknown', 'on_stale', 'stale', 'on_invalid', 'invalid', 'on_aging', 'aging', 'on_fresh', 'fresh'] as const) {
        checkOutcome(`$.defaults.${key}`, d[key], out);
      }
      if (d.on_invalid !== undefined || d.invalid !== undefined) {
        const invalidOutcome = d.on_invalid ?? d.invalid;
        if (invalidOutcome === 'allow') {
          out.push(v('$.defaults.on_invalid', 'defaults.on_invalid: "allow" is forbidden — proven state changes must never authorize the original action'));
        }
      }
      if (d.default_freshness !== undefined) {
        validateFreshnessConfig('$.defaults.default_freshness', d.default_freshness, out);
      }
      if (d.aging_threshold !== undefined) {
        const t = d.aging_threshold;
        if (typeof t !== 'number' || t <= 0 || t > 1) {
          out.push(v('$.defaults.aging_threshold', 'aging_threshold must be a number in (0, 1]'));
        }
      }
      checkDuration('$.defaults.clock_skew_tolerance', d.clock_skew_tolerance, out);
      checkDuration('$.defaults.execution_deadline', d.execution_deadline, out);
    }
  }

  // Dangerous default: UNKNOWN -> allow requires explicit acknowledgment.
  const unknownOutcome = defaults?.on_unknown ?? defaults?.unknown;
  if (unknownOutcome === 'allow' && fw.acknowledge_unknown_allow !== true) {
    out.push(
      v(
        '$.defaults.on_unknown',
        'UNKNOWN -> "allow" is a dangerous default; set firewall.acknowledge_unknown_allow: true to accept it explicitly',
      ),
    );
  }

  const policies = config.actions ?? [];
  const names = new Set<string>();
  policies.forEach((policy, i) => {
    validatePolicyConfig(`$.actions[${i}]`, policy, out);
    if (typeof (policy as FirewallPolicyConfig).name === 'string') {
      const name = (policy as FirewallPolicyConfig).name;
      if (names.has(name)) {
        out.push(v(`$.actions[${i}].name`, `duplicate policy name "${name}"`));
      }
      names.add(name);
    }
  });

  if (config.policies_file !== undefined && typeof config.policies_file !== 'string') {
    out.push(v('$.policies_file', 'policies_file must be a string path'));
  }

  validateProviders('$.providers', config.providers, out);

  if (config.risk_defaults !== undefined) {
    if (!isRecord(config.risk_defaults)) {
      out.push(v('$.risk_defaults', 'risk_defaults must be an object'));
    } else {
      unknownKeys('$.risk_defaults', config.risk_defaults, RISK_DEFAULTS_KEYS, out);
      const rd = config.risk_defaults as { rules?: RiskDefaultRule[]; default?: RiskLevel };
      if (rd.rules !== undefined) {
        if (!Array.isArray(rd.rules)) {
          out.push(v('$.risk_defaults.rules', 'rules must be an array'));
        } else {
          rd.rules.forEach((rule, i) => {
            if (!isRecord(rule) || typeof rule['match'] !== 'string' || rule['match'].length === 0) {
              out.push(v(`$.risk_defaults.rules[${i}].match`, 'risk rule requires an operation glob pattern'));
            }
            checkRisk(`$.risk_defaults.rules[${i}].risk`, rule?.['risk'], out);
          });
        }
      }
      checkRisk('$.risk_defaults.default', rd.default, out);
    }
  }

  if (config.policy_tests !== undefined) {
    if (!Array.isArray(config.policy_tests)) {
      out.push(v('$.policy_tests', 'policy_tests must be an array'));
    } else {
      config.policy_tests.forEach((test, i) => validatePolicyTest(`$.policy_tests[${i}]`, test, out));
    }
  }

  if (config.telemetry !== undefined && !isRecord(config.telemetry)) {
    out.push(v('$.telemetry', 'telemetry must be an object'));
  }
  if (config.logging !== undefined) {
    if (!isRecord(config.logging)) {
      out.push(v('$.logging', 'logging must be an object'));
    } else {
      const level = config.logging['level'];
      if (level !== undefined && !['debug', 'info', 'warn', 'error'].includes(level as string)) {
        out.push(v('$.logging.level', `expected debug|info|warn|error, got ${JSON.stringify(level)}`));
      }
    }
  }

  return out;
}

export { checkPrecondition as validatePreconditionValue };
export type { PreconditionConfig };
