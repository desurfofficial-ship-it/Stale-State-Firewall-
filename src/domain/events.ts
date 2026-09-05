/**
 * Internal event model (spec §39).
 *
 * The architecture is event-oriented even though the first implementation is
 * a modular monolith: every lifecycle transition is emitted as a typed event
 * on an EventBus, which the audit engine, telemetry, and logging subscribe to.
 */

export type FirewallEventType =
  | 'StateObserved'
  | 'StateExpired'
  | 'StateChanged'
  | 'ActionProposed'
  | 'ActionValidated'
  | 'ActionBlocked'
  | 'ActionRevalidated'
  | 'ActionExecuted'
  | 'ActionFailed'
  | 'PolicyEvaluated'
  | 'ProviderError'
  | 'EscalationRequested'
  | 'EscalationResolved'
  | 'ReplayDetected';

export interface FirewallEvent<T = unknown> {
  type: FirewallEventType;
  occurred_at: string;
  data: T;
}

export type EventHandler = (event: FirewallEvent) => void | Promise<void>;

export interface EventBus {
  emit(event: FirewallEvent): void;
  subscribe(type: FirewallEventType | '*', handler: EventHandler): () => void;
}

export class SynchronousEventBus implements EventBus {
  private readonly handlers = new Map<FirewallEventType | '*', Set<EventHandler>>();

  subscribe(type: FirewallEventType | '*', handler: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  emit(event: FirewallEvent): void {
    const specific = this.handlers.get(event.type);
    const wildcard = this.handlers.get('*');
    for (const handler of specific ?? []) {
      handler(event);
    }
    for (const handler of wildcard ?? []) {
      handler(event);
    }
  }
}
