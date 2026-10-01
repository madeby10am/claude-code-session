import { describe, it, expect } from 'vitest';
import { visibleSessions, dismiss, forgetStale, DISMISS_GRACE_MS } from '../src/session/dismissed';
import type { SessionState } from '../src/session/types';

const mk = (sessionId: string, lastSeen: number, entrypoint = 'claude-vscode') =>
  ({ sessionId, lastSeen, entrypoint } as SessionState);

describe('visibleSessions', () => {
  it('hides a dismissed session with no newer activity', () => {
    const d = dismiss({}, 'a', 1000);
    expect(visibleSessions([mk('a', 900), mk('b', 900)], d).map(s => s.sessionId)).toEqual(['b']);
  });

  it('ignores a trailing log line within the grace window', () => {
    const d = dismiss({}, 'a', 1000);
    expect(visibleSessions([mk('a', 1000 + DISMISS_GRACE_MS - 1)], d)).toHaveLength(0);
  });

  it('shows a dismissed session again once it has real new activity', () => {
    const d = dismiss({}, 'a', 1000);
    expect(visibleSessions([mk('a', 1000 + DISMISS_GRACE_MS + 1)], d)).toHaveLength(1);
  });
});

describe('background sessions', () => {
  it('never shows Agent SDK sessions', () => {
    const all = [mk('ui', 1), mk('bg', 1, 'sdk-py'), mk('bg2', 1, 'sdk-ts')];
    expect(visibleSessions(all, {}).map(s => s.sessionId)).toEqual(['ui']);
  });
});

describe('forgetStale', () => {
  it('drops entries older than a day', () => {
    const now = 10 * 24 * 3600 * 1000;
    const out = forgetStale({ old: 1000, fresh: now - 1000 }, now);
    expect(Object.keys(out)).toEqual(['fresh']);
  });
});
