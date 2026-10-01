// Turns `git reflog` lines into a short, human-readable activity feed.
// HEAD's reflog covers commits, merges and pulls; the origin/<branch> reflog
// is the only place a push is recorded ("update by push").

export type GitActivityKind = 'pushed' | 'pulled' | 'merged' | 'committed' | 'fetched' | 'rebased';

export interface GitActivity {
  kind:  GitActivityKind;
  ts:    number;   // ms
  label: string;   // short detail, e.g. commit subject
  repo?: string;   // folder name of the repo it happened in
}

// Lines look like `HEAD@{1699999999}\tcommit: fix thing` (from --date=unix).
export function parseReflog(output: string, source: 'head' | 'remote'): GitActivity[] {
  const out: GitActivity[] = [];
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const m = line.slice(0, tab).match(/@\{(\d+)\}/);
    if (!m) continue;
    const ts = parseInt(m[1], 10) * 1000;
    const subject = line.slice(tab + 1).trim();
    const kind = classify(subject, source);
    if (!kind) continue;
    const colon = subject.indexOf(':');
    // Only commits/merges carry a meaningful message; the rest is reflog noise.
    const detail = kind === 'committed' || kind === 'merged';
    out.push({ kind, ts, label: detail && colon >= 0 ? subject.slice(colon + 1).trim() : '' });
  }
  return out;
}

function classify(subject: string, source: 'head' | 'remote'): GitActivityKind | null {
  if (source === 'remote') {
    if (subject.startsWith('update by push')) return 'pushed';
    if (subject.startsWith('pull')) return 'pulled';
    if (subject.startsWith('fetch')) return 'fetched';
    return null;
  }
  if (subject.startsWith('commit (merge)') || subject.startsWith('merge')) return 'merged';
  if (subject.startsWith('commit')) return 'committed';
  if (subject.startsWith('pull')) return 'pulled';
  if (subject.startsWith('rebase')) return 'rebased';
  return null;
}

// Newest first. A pull shows up in both reflogs, so collapse same-kind
// events that land within a few seconds of each other.
export function mergeActivity(lists: GitActivity[][], limit = 8): GitActivity[] {
  const all = lists.flat().sort((a, b) => b.ts - a.ts);
  const out: GitActivity[] = [];
  for (const e of all) {
    const dup = out.some(o => o.repo === e.repo && o.kind === e.kind && Math.abs(o.ts - e.ts) < 5000);
    if (!dup) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
