/** In-process fan-out of persisted events and session-list changes to WebSocket handlers. */
import type { EventEnvelope } from '@mobile-ide/core';
import { errorInfo, log } from './log.js';

export type Unsubscribe = () => void;

export class EventBus {
  private readonly eventListeners = new Set<(env: EventEnvelope) => void>();
  private readonly sessionsListeners = new Set<() => void>();
  private readonly hostListeners = new Set<(agentId: string) => void>();

  onEvent(fn: (env: EventEnvelope) => void): Unsubscribe {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  emitEvent(env: EventEnvelope): void {
    for (const fn of this.eventListeners) {
      try {
        fn(env);
      } catch (err) {
        log.error('bus.event.listener_failed', errorInfo(err));
      }
    }
  }

  onSessionsChanged(fn: () => void): Unsubscribe {
    this.sessionsListeners.add(fn);
    return () => this.sessionsListeners.delete(fn);
  }

  emitSessionsChanged(): void {
    for (const fn of this.sessionsListeners) {
      try {
        fn();
      } catch (err) {
        log.error('bus.sessions.listener_failed', errorInfo(err));
      }
    }
  }

  onHostChanged(fn: (agentId: string) => void): Unsubscribe {
    this.hostListeners.add(fn);
    return () => this.hostListeners.delete(fn);
  }

  emitHostChanged(agentId: string): void {
    for (const fn of this.hostListeners) {
      try {
        fn(agentId);
      } catch (err) {
        log.error('bus.host.listener_failed', errorInfo(err));
      }
    }
  }
}
