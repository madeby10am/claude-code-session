import { describe, it, expect } from 'vitest';
import { matchSessionByTabLabel } from '../src/session/tabMatch';
import type { SessionState } from '../src/session/types';

const mk = (sessionId: string, chatTitle: string, lastSeen = 0) =>
  ({ sessionId, chatTitle, lastSeen } as SessionState);

describe('matchSessionByTabLabel', () => {
  const sessions = [mk('a', 'Fix login bug', 1), mk('b', 'Redesign sidebar', 2)];

  it('matches an exact title, ignoring case and whitespace', () => {
    expect(matchSessionByTabLabel('  redesign SIDEBAR ', sessions)).toBe('b');
  });

  it('prefers the most recent session when titles collide', () => {
    const dup = [mk('old', 'Same', 1), mk('new', 'Same', 9)];
    expect(matchSessionByTabLabel('Same', dup)).toBe('new');
  });

  it('matches a truncated tab label by prefix', () => {
    expect(matchSessionByTabLabel('Redesign si…', sessions)).toBe('b');
  });

  it('returns undefined for non-Claude labels and empty input', () => {
    expect(matchSessionByTabLabel('panel.ts', sessions)).toBeUndefined();
    expect(matchSessionByTabLabel('', sessions)).toBeUndefined();
  });
});
