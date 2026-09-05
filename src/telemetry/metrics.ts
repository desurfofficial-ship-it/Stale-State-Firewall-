/**
 * Structured telemetry (spec §35).
 *
 * Local, in-process counters and latency aggregates. No hosted control plane
 * is required; everything works offline. Metrics are exposed through the SDK
 * (`firewall.getMetrics()`) and `ssf doctor --json`.
 */

export interface MetricCounters {
  actions_checked: number;
  actions_allowed: number;
  actions_denied: number;
  actions_revalidated: number;
  actions_escalated: number;
  stale_state_events: number;
  provider_failures: number;
  policy_failures: number;
  replays_detected: number;
  escalations_requested: number;
  escalations_resolved: number;
}

export interface LatencyStats {
  count: number;
  avg_ms: number;
  max_ms: number;
}

export interface MetricsSnapshot {
  counters: MetricCounters;
  latency: {
    validation: LatencyStats;
    revalidation: LatencyStats;
    execution: LatencyStats;
  };
}

function emptyCounters(): MetricCounters {
  return {
    actions_checked: 0,
    actions_allowed: 0,
    actions_denied: 0,
    actions_revalidated: 0,
    actions_escalated: 0,
    stale_state_events: 0,
    provider_failures: 0,
    policy_failures: 0,
    replays_detected: 0,
    escalations_requested: 0,
    escalations_resolved: 0,
  };
}

class LatencySeries {
  private count = 0;
  private sum = 0;
  private max = 0;

  observe(ms: number): void {
    this.count += 1;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  stats(): LatencyStats {
    return {
      count: this.count,
      avg_ms: this.count === 0 ? 0 : Math.round((this.sum / this.count) * 1000) / 1000,
      max_ms: this.max,
    };
  }
}

export class MetricsRegistry {
  private counters: MetricCounters = emptyCounters();
  private readonly validation = new LatencySeries();
  private readonly revalidation = new LatencySeries();
  private readonly execution = new LatencySeries();

  increment(counter: keyof MetricCounters, by = 1): void {
    this.counters[counter] += by;
  }

  observeValidationLatency(ms: number): void {
    this.validation.observe(ms);
  }

  observeRevalidationLatency(ms: number): void {
    this.revalidation.observe(ms);
  }

  observeExecutionLatency(ms: number): void {
    this.execution.observe(ms);
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: { ...this.counters },
      latency: {
        validation: this.validation.stats(),
        revalidation: this.revalidation.stats(),
        execution: this.execution.stats(),
      },
    };
  }

  reset(): void {
    this.counters = emptyCounters();
  }
}
