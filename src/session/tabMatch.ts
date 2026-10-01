import type { SessionState } from './types';

// Claude Code names each editor tab after its chat title (via rename_tab), and
// SessionManager reads the same title from the JSONL log. Match on that.
const ELLIPSIS = /…|\.{3}$/;

const norm = (s: string) => s.replace(/^[\s●•*]+/, '').trim().toLowerCase();

export function matchSessionByTabLabel(
  label: string,
  sessions: Iterable<SessionState>
): string | undefined {
  const want = norm(label);
  if (!want) return undefined;

  const list = Array.from(sessions).filter(s => s.chatTitle);
  const newest = (a: SessionState, b: SessionState) => (b.lastSeen || 0) - (a.lastSeen || 0);

  const exact = list.filter(s => norm(s.chatTitle) === want).sort(newest);
  if (exact.length) return exact[0].sessionId;

  // Tabs truncate long titles with an ellipsis; fall back to a prefix match.
  if (ELLIPSIS.test(label)) {
    const stem = want.replace(ELLIPSIS, '').trim();
    if (stem) {
      const pre = list.filter(s => norm(s.chatTitle).startsWith(stem)).sort(newest);
      if (pre.length) return pre[0].sessionId;
    }
  }
  return undefined;
}
