import type { SessionState } from './types';

// sessionId -> time (ms) the user closed or dismissed it. A dismissed session
// stays hidden until its log shows activity after that moment.
export type Dismissed = Record<string, number>;

// A final log line can land just after a tab closes; don't let it revive the session.
export const DISMISS_GRACE_MS = 5000;
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

export function visibleSessions(all: Iterable<SessionState>, dismissed: Dismissed): SessionState[] {
  return Array.from(all).filter(s => {
    const at = dismissed[s.sessionId];
    return at === undefined || (s.lastSeen || 0) > at;
  });
}

export function dismiss(dismissed: Dismissed, sessionId: string, now = Date.now()): Dismissed {
  return { ...dismissed, [sessionId]: now + DISMISS_GRACE_MS };
}

// Sessions this old have aged out of the manager anyway; keep the stored map small.
export function forgetStale(dismissed: Dismissed, now = Date.now()): Dismissed {
  return Object.fromEntries(Object.entries(dismissed).filter(([, at]) => now - at < FORGET_AFTER_MS));
}
