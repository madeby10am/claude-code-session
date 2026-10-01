import { describe, it, expect } from 'vitest';
import { parseReflog, mergeActivity } from '../src/session/gitActivity';

describe('parseReflog', () => {
  it('classifies HEAD entries and skips checkouts', () => {
    const out = parseReflog(
      'HEAD@{300}\tcommit: add thing\nHEAD@{200}\tcheckout: moving from a to b\nHEAD@{100}\tpull: Fast-forward',
      'head');
    expect(out.map(e => e.kind)).toEqual(['committed', 'pulled']);
    expect(out[0]).toMatchObject({ ts: 300000, label: 'add thing' });
  });

  it('recognises merges and pushes', () => {
    expect(parseReflog('HEAD@{1}\tcommit (merge): Merge x', 'head')[0].kind).toBe('merged');
    expect(parseReflog('refs/remotes/origin/main@{1}\tupdate by push', 'remote')[0].kind).toBe('pushed');
  });
});

describe('mergeActivity', () => {
  it('sorts newest first and collapses same-kind duplicates', () => {
    const a = [{ kind: 'pulled' as const, ts: 10_000, label: '' }];
    const b = [{ kind: 'pulled' as const, ts: 11_000, label: '' }, { kind: 'pushed' as const, ts: 50_000, label: '' }];
    const out = mergeActivity([a, b]);
    expect(out.map(e => e.kind)).toEqual(['pushed', 'pulled']);
  });
});
