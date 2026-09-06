/**
 * Continuous dogfood harness — step verdict taxonomy (operationalization §14).
 *
 * Every scenario step resolves to exactly one of these. The distinction is
 * the point of the harness: an EXPECTED_SECURITY_BLOCK is the firewall
 * working; a SECURITY_FAILURE is the firewall NOT working; an
 * UNEXPECTED_FAILURE is an integration/environment problem; a
 * DOCUMENTED_BOUNDARY is behavior inside a documented guarantee boundary
 * (recorded honestly, never silently).
 */

export const STEP = {
  /** A mandated block happened (stale action refused, replay refused, ...). */
  EXPECTED_SECURITY_BLOCK: 'EXPECTED_SECURITY_BLOCK',
  /** A legitimate action was authorized and executed. */
  EXPECTED_SUCCESS: 'EXPECTED_SUCCESS',
  /** Behavior inside a documented guarantee boundary (e.g. DF-F2, If-Match operator duty). */
  DOCUMENTED_BOUNDARY: 'DOCUMENTED_BOUNDARY',
  /** An assertion failed or behavior deviated without a security implication. */
  UNEXPECTED_FAILURE: 'UNEXPECTED_FAILURE',
  /** An expected block DID NOT happen — unsafe execution. Highest priority. */
  SECURITY_FAILURE: 'SECURITY_FAILURE',
};

export const SCENARIO_VERDICT = {
  PASS: 'PASS',
  SECURITY_FAILURE: 'SECURITY_FAILURE',
  UNEXPECTED_FAILURE: 'UNEXPECTED_FAILURE',
  SKIPPED: 'SKIPPED',
  ERROR: 'ERROR',
};

/** Overall scenario verdict from its step outcomes. */
export function scenarioVerdict(steps) {
  if (steps.some((s) => s.verdict === STEP.SECURITY_FAILURE)) return SCENARIO_VERDICT.SECURITY_FAILURE;
  if (steps.some((s) => s.verdict === STEP.UNEXPECTED_FAILURE)) return SCENARIO_VERDICT.UNEXPECTED_FAILURE;
  return SCENARIO_VERDICT.PASS;
}

/** Helper for scenario modules: assert a block happened, else SECURITY_FAILURE. */
export function expectBlock(condition, name, detail) {
  return {
    name,
    verdict: condition ? STEP.EXPECTED_SECURITY_BLOCK : STEP.SECURITY_FAILURE,
    detail,
  };
}

/** Helper: assert an expected success. */
export function expectSuccess(condition, name, detail) {
  return {
    name,
    verdict: condition ? STEP.EXPECTED_SUCCESS : STEP.UNEXPECTED_FAILURE,
    detail,
  };
}

/** Helper: record behavior inside a documented boundary (condition = it behaved as documented). */
export function documentedBoundary(condition, name, detail) {
  return {
    name,
    verdict: condition ? STEP.DOCUMENTED_BOUNDARY : STEP.UNEXPECTED_FAILURE,
    detail,
  };
}
