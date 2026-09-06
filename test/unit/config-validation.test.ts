import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/config/validation.js';
import { loadConfigFile } from '../../src/config/loader.js';
import { PolicyValidationError } from '../../src/domain/errors.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';

function violationsOf(config: unknown) {
  return validateConfig(config as never);
}

function pathOf(violations: ReturnType<typeof validateConfig>, suffix: string): boolean {
  return violations.some((v) => v.path.endsWith(suffix));
}

describe('config validation (spec §30)', () => {
  const minimal = {
    firewall: { mode: 'enforce' },
  };

  it('accepts the minimal valid configuration', () => {
    expect(violationsOf(minimal)).toHaveLength(0);
  });

  it('rejects unknown top-level fields', () => {
    const violations = violationsOf({ ...minimal, mystery: true });
    expect(pathOf(violations, '.mystery')).toBe(true);
  });

  it('rejects invalid modes', () => {
    expect(pathOf(violationsOf({ firewall: { mode: 'yolo' } }), '.mode')).toBe(true);
  });

  it('rejects invalid outcome decisions everywhere', () => {
    const violations = violationsOf({
      ...minimal,
      defaults: { on_unknown: 'shrug' },
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it('rejects unknown fields deep inside policies', () => {
    const violations = violationsOf({
      ...minimal,
      actions: [{ name: 'p', match: { operation: 'x' }, bogus: 1 }],
    });
    expect(pathOf(violations, '.bogus')).toBe(true);
  });

  it('requires ttl policies to declare max_age', () => {
    const violations = violationsOf({
      ...minimal,
      actions: [{ name: 'p', match: { operation: 'x' }, freshness: { strategy: 'ttl' } }],
    });
    expect(pathOf(violations, '.freshness.max_age')).toBe(true);
  });

  it('rejects max_age on pure version strategies (contradictory semantics)', () => {
    const violations = violationsOf({
      ...minimal,
      actions: [{ name: 'p', match: { operation: 'x' }, freshness: { strategy: 'version', max_age: '5s' } }],
    });
    expect(pathOf(violations, '.freshness.max_age')).toBe(true);
  });

  it('rejects impossible preconditions: string comparison with numeric operator', () => {
    const violations = violationsOf({
      ...minimal,
      actions: [{
        name: 'p',
        match: { operation: 'x' },
        preconditions: [{ field: 'count', operator: 'greater_than', value: 'ten' }],
      }],
    });
    expect(pathOf(violations, '.preconditions[0].value')).toBe(true);
  });

  it('rejects invalid regex in matches operator', () => {
    const violations = violationsOf({
      ...minimal,
      actions: [{
        name: 'p',
        match: { operation: 'x' },
        preconditions: [{ field: 'env', operator: 'matches', value: '([unclosed' }],
      }],
    });
    expect(pathOf(violations, '.preconditions[0].value')).toBe(true);
  });

  it('rejects exists/not_exists carrying a value', () => {
    const violations = violationsOf({
      ...minimal,
      actions: [{
        name: 'p',
        match: { operation: 'x' },
        preconditions: [{ field: 'env', operator: 'exists', value: 'x' }],
      }],
    });
    expect(pathOf(violations, '.preconditions[0].value')).toBe(true);
  });

  it('rejects duplicate policy names', () => {
    const violations = violationsOf({
      ...minimal,
      actions: [
        { name: 'p', match: { operation: 'a' } },
        { name: 'p', match: { operation: 'b' } },
      ],
    });
    expect(pathOf(violations, '.name')).toBe(true);
  });

  it('rejects empty matchers (they would silently match everything)', () => {
    const violations = violationsOf({
      ...minimal,
      actions: [{ name: 'p', match: {} }],
    });
    expect(pathOf(violations, '.match')).toBe(true);
  });

  it('rejects structurally identical matchers (ambiguous resolution)', () => {
    const violations = violationsOf({
      ...minimal,
      actions: [
        { name: 'p1', match: { operation: 'same' } },
        { name: 'p2', match: { operation: 'same' } },
      ],
    });
    expect(violations.some((v) => v.message.includes('identical matchers'))).toBe(true);
  });
});

describe('dangerous defaults (spec §31)', () => {
  it('UNKNOWN -> allow requires explicit acknowledgment', () => {
    const violations = validateConfig({
      firewall: { mode: 'enforce' },
      defaults: { on_unknown: 'allow' },
    } as never);
    expect(pathOf(violations, '.on_unknown')).toBe(true);

    const acknowledged = validateConfig({
      firewall: { mode: 'enforce', acknowledge_unknown_allow: true },
      defaults: { on_unknown: 'allow' },
    } as never);
    expect(acknowledged).toHaveLength(0);
  });

  it('on_invalid: allow is forbidden everywhere — proven state change must block', () => {
    const violations = validateConfig({
      firewall: { mode: 'enforce' },
      actions: [{ name: 'p', match: { operation: 'x' }, on_invalid: 'allow' }],
    } as never);
    expect(pathOf(violations, '.on_invalid')).toBe(true);
  });
});

describe('policy test scenario validation', () => {
  it('rejects tests with invalid expected decisions or missing fixtures', () => {
    const violations = validateConfig({
      firewall: { mode: 'enforce' },
      policy_tests: [{ name: 't', action: { operation: 'x' }, state: 'nope', expect_decision: 'MAYBE' }],
    } as never);
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe('YAML loading (spec §33)', () => {
  it('loads and validates ssf.config.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssf-config-'));
    const file = join(dir, 'ssf.config.yaml');
    writeFileSync(
      file,
      yamlStringify({
        firewall: { mode: 'enforce', storage: { type: 'memory' } },
        actions: [{ name: 'p', match: { operation: 'deploy*' }, risk: 'CRITICAL', freshness: { strategy: 'version' } }],
      }),
    );
    const loaded = loadConfigFile(file);
    expect(loaded.policies).toHaveLength(1);
    expect(loaded.policies[0]?.name).toBe('p');
    expect(loaded.riskDefaults).toBeNull();
  });

  it('throws PolicyValidationError with violations for malformed files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssf-config-'));
    const file = join(dir, 'ssf.config.yaml');
    writeFileSync(file, 'firewall:\n  mode: banana\n');
    expect(() => loadConfigFile(file)).toThrow(PolicyValidationError);
    try {
      loadConfigFile(file);
    } catch (error) {
      expect((error as PolicyValidationError).violations.length).toBeGreaterThan(0);
    }
  });

  it('loads external policies files and validates them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssf-config-'));
    const config = join(dir, 'ssf.config.yaml');
    const policies = join(dir, 'policies.yaml');
    writeFileSync(policies, yamlStringify({
      schema_version: '1',
      policies: [{ name: 'external', match: { operation: 'x' } }],
    }));
    writeFileSync(config, yamlStringify({
      firewall: { mode: 'observe' },
      policies_file: './policies.yaml',
    }));
    const loaded = loadConfigFile(config);
    expect(loaded.policies.map((p) => p.name)).toEqual(['external']);
  });

  it('rejects unsupported policy schema versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssf-config-'));
    const config = join(dir, 'ssf.config.yaml');
    const policies = join(dir, 'policies.yaml');
    writeFileSync(policies, yamlStringify({ schema_version: '99', policies: [] }));
    writeFileSync(config, yamlStringify({
      firewall: { mode: 'observe' },
      policies_file: './policies.yaml',
    }));
    expect(() => loadConfigFile(config)).toThrow(/schema version/);
  });
});
