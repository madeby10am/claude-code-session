import * as fs   from 'fs';
import * as path from 'path';
import { CLAUDE_DIR } from './claudeEnvironment';
import type { SessionState } from './types';

// A session on disk, recent or not. `filePath` is its real identity: a resumed
// log can report a sessionId that differs from its file name.
export interface SavedSession extends Pick<SessionState, 'sessionId' | 'chatTitle' | 'projectName' | 'lastSeen'> {
  filePath: string;
}

const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Only a UUID-named transcript directly inside a project folder qualifies, so a
// bad path can't widen what gets deleted.
export function isSessionLog(filePath: string, claudeDir = CLAUDE_DIR): boolean {
  const resolved = path.resolve(filePath);
  return path.extname(resolved) === '.jsonl'
    && SESSION_ID.test(path.basename(resolved, '.jsonl'))
    && path.dirname(path.dirname(resolved)) === path.join(claudeDir, 'projects');
}

// Everything Claude Code keeps for one session, transcript first: the log, its
// subagent/tool-result folder, and its file backups and environment snapshots.
export function sessionDataPaths(filePath: string, claudeDir = CLAUDE_DIR): string[] {
  if (!isSessionLog(filePath, claudeDir)) { return []; }
  const id = path.basename(filePath, '.jsonl');
  return [
    filePath,
    path.join(path.dirname(filePath), id),
    path.join(claudeDir, 'file-history', id),
    path.join(claudeDir, 'session-env', id),
  ].filter(p => fs.existsSync(p));
}

function isAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) { return false; }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Each Claude Code process registers itself in ~/.claude/sessions/<pid>.json.
// Crashed processes leave their file behind, so the pid has to be checked too.
export function runningSessionIds(claudeDir = CLAUDE_DIR): Set<string> {
  const running = new Set<string>();
  const dir = path.join(claudeDir, 'sessions');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch { return running; }

  for (const file of files) {
    try {
      const { pid, sessionId } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (typeof sessionId === 'string' && isAlive(pid)) { running.add(sessionId); }
    } catch { /* removed or mid-write */ }
  }
  return running;
}

export function isRunning(session: Pick<SavedSession, 'sessionId' | 'filePath'>, running: Set<string>): boolean {
  return running.has(session.sessionId) || running.has(path.basename(session.filePath, '.jsonl'));
}
