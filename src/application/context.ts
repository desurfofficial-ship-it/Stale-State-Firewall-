/**
 * Shared application context wiring the domain engines to infrastructure.
 * Dependency inversion: use cases depend on this interface, never on
 * concrete storage, providers, or clock implementations (spec §41).
 */

import type { Clock } from '../engine/clock.js';
import type { StateProvider } from '../providers/types.js';
import type { FirewallStore } from '../storage/types.js';
import type { AuditEngine } from '../audit/audit-engine.js';
import type { EventBus } from '../domain/events.js';
import type { MetricsRegistry } from '../telemetry/metrics.js';
import type { Logger } from '../logging/logger.js';
import type { ResolvedPolicy, GlobalDefaults } from '../engine/resolved-policy.js';
import type { RiskDefaultsConfig } from '../domain/policy.js';
import type { FirewallMode } from '../domain/decision.js';

export interface FirewallContext {
  clock: Clock;
  providers: StateProvider[];
  store: FirewallStore;
  audit: AuditEngine;
  events: EventBus;
  metrics: MetricsRegistry;
  logger: Logger;
  policies: ResolvedPolicy[];
  defaults: GlobalDefaults;
  riskDefaults: RiskDefaultsConfig | null;
  mode: FirewallMode;
  policyVersion: string;
}
