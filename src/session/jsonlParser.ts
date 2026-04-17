import * as path from 'path';
import * as fs   from 'fs';
import { SessionEntry, SessionState, getContextLimit } from './types';

export function toProjectName(slug: string): string {
  const parts = slug.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean).slice(-3);
  return meaningful
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/** Find the last occurrence of `marker` in a JSONL string, parse its line, and return `field`. */
export function extractLastField(content: string, marker: string, field: string): string | undefined {
  const idx = content.lastIndexOf(marker);
  if (idx === -1) { return undefined; }
  const lineStart = content.lastIndexOf('\n', idx) + 1;
  const lineEnd   = content.indexOf('\n', idx);
  const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
  if (!line) { return undefined; }
  try {
    return JSON.parse(line)[field] as string | undefined;
  } catch { return undefined; }
}

export function defaultSession(
  sessionId: string,
  slug:      string,
  hueShift:  number
): SessionState {
  return {
    sessionId,
    slug,
    projectName:  toProjectName(slug),
    chatTitle:      '',
    cwd:            '',
    gitBranch:      '',
    model:          '',
    version:        '',
    entrypoint:     '',
    permissionMode: '',
    speed:          '',
    effort:         '',
    inputTokens:    0,
    outputTokens:   0,
    lastInputTokens:  0,
    lastOutputTokens: 0,
    contextPct:     0,
    currentFile:    '',
    turnCount:      0,
    toolUseCount:   0,
    lastAction:     '',
    needsInput:     false,
    activity:       'idle',
    lastSeen:     Date.now(),
    startedAt:    Date.now(),
    hueShift,
  };
}

export function humanizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':  return `Reading ${path.basename(String(input['file_path'] || ''))}`;
    case 'Edit':  return `Editing ${path.basename(String(input['file_path'] || ''))}`;
    case 'Write': return `Writing ${path.basename(String(input['file_path'] || ''))}`;
    case 'Bash': {
      const cmd = String(input['command'] || '');
      return `Running ${cmd.slice(0, 30)}${cmd.length > 30 ? '...' : ''}`;
    }
    case 'Grep':  return `Searching for ${String(input['pattern'] || '')}`;
    case 'Glob':  return `Finding ${String(input['pattern'] || '')}`;
    case 'Agent': return String(input['description'] || 'Delegating task');
    default:      return name;
  }
}

/** Callback invoked when a JSONL entry changes the session's id (re-keying). */
export type RekeyCallback = (oldId: string, newId: string) => void;

/** Parse a chunk of raw JSONL text, applying each line to `entry`. Returns true if any state changed. */
export function parseLines(raw: string, entry: SessionEntry, onRekey?: RekeyCallback): boolean {
  if (!raw) { return false; }

  const lines = raw.split('\n');
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (applyEntry(obj, entry, onRekey)) {
      changed = true;
    }
  }

  return changed;
}

function applyEntry(
  obj:      Record<string, unknown>,
  entry:    SessionEntry,
  onRekey?: RekeyCallback
): boolean {
  let changed = false;
  const s = entry.state;

  if (typeof obj['sessionId'] === 'string' && obj['sessionId']) {
    const newId = obj['sessionId'] as string;
    if (newId !== s.sessionId) {
      const oldId = s.sessionId;
      s.sessionId = newId;
      onRekey?.(oldId, newId);
      changed = true;
    }
  }

  if (typeof obj['timestamp'] === 'string' || typeof obj['timestamp'] === 'number') {
    const ts = typeof obj['timestamp'] === 'string'
      ? new Date(obj['timestamp'] as string).getTime()
      : obj['timestamp'] as number;
    if (!isNaN(ts) && ts > 0) { s.lastSeen = ts; }
    changed = true;
  }

  const entrypoint = obj['entrypoint'] as string | undefined;
  if (entrypoint && !s.entrypoint) {
    s.entrypoint = entrypoint;
    changed = true;
  }

  const effort = (obj['reasoningEffort'] ?? obj['reasoning_effort']) as string | undefined;
  if (effort) {
    s.effort = effort;
    changed = true;
  }

  const type = obj['type'] as string | undefined;

  if (type === 'ai-title') {
    const title = obj['aiTitle'] as string | undefined;
    if (title) {
      s.chatTitle = title;
      changed = true;
    }
    return changed;
  }

  if (type === 'custom-title') {
    const title = obj['customTitle'] as string | undefined;
    if (title) {
      s.chatTitle = title;
      changed = true;
    }
    return changed;
  }

  if (type === 'file-history-snapshot') {
    const snapshot = obj['snapshot'] as Record<string, unknown> | undefined;
    const backups  = snapshot?.['trackedFileBackups'] as Record<string, unknown> | undefined;
    if (backups) {
      const keys = Object.keys(backups);
      if (keys.length > 0) {
        s.currentFile = path.basename(keys[0]);
        changed = true;
      }
    }
    return changed;
  }

  if (type === 'user') {
    const perm = obj['permissionMode'] as string | undefined;
    if (perm) {
      s.permissionMode = perm;
      changed = true;
    }

    const msg = obj['message'] as Record<string, unknown> | undefined;
    const content = msg?.['content'] ?? obj['content'];
    const hasToolResult = Array.isArray(content) &&
      content.some(
        (c: unknown) =>
          typeof c === 'object' &&
          c !== null &&
          (c as Record<string, unknown>)['type'] === 'tool_result'
      );

    s.needsInput = false;
    if (!hasToolResult) {
      s.activity = 'user_sent';
      s.lastSeen = Date.now();
      s.turnCount++;
    }
    changed = true;
    return changed;
  }

  if (type === 'assistant') {
    const message    = obj['message']    as Record<string, unknown> | undefined;
    const stopReason = (message?.['stop_reason'] ?? obj['stop_reason']) as string | undefined;

    const contentBlocks = message?.['content'] as unknown[] | undefined;
    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as Record<string, unknown>)['type'] === 'tool_use'
        ) {
          s.toolUseCount++;
          const toolBlock = block as Record<string, unknown>;
          const toolName = toolBlock['name'] as string || '';
          const toolInput = (toolBlock['input'] as Record<string, unknown>) || {};
          s.lastAction = humanizeToolUse(toolName, toolInput);
          if (toolName === 'AskUserQuestion') {
            s.needsInput = true;
          }
          changed = true;
        }
      }
    }

    if (stopReason === 'tool_use') {
      s.activity = 'tooling';
      s.lastSeen = Date.now();
      changed = true;
    } else if (stopReason === 'end_turn') {
      s.activity = 'responding';
      s.lastSeen = Date.now();
      changed = true;

      const textBlocks = Array.isArray(contentBlocks)
        ? contentBlocks.filter(
            (b): b is Record<string, unknown> =>
              typeof b === 'object' && b !== null &&
              (b as Record<string, unknown>)['type'] === 'text'
          )
        : [];
      if (textBlocks.length > 0) {
        const lastText = String(
          (textBlocks[textBlocks.length - 1] as Record<string, unknown>)['text'] ?? ''
        ).trimEnd();
        const isQuestion =
          lastText.endsWith('?') ||
          /\b(which|would you( like)?|do you want|please (choose|select|let me know)|what would|how would you|shall i|should i)\b/i.test(lastText) ||
          /^\s*\d+[.)]\s+\S/m.test(lastText);
        s.needsInput = isQuestion;
      } else {
        s.needsInput = false;
      }

      const model = (message?.['model'] ?? obj['model']) as string | undefined;
      if (model) { s.model = model; }

      const usage = (message?.['usage'] ?? obj['usage']) as Record<string, unknown> | undefined;
      if (usage) {
        const cacheCreate = (usage['cache_creation_input_tokens'] as number | undefined) ?? 0;
        const cacheRead   = (usage['cache_read_input_tokens']     as number | undefined) ?? 0;

        if (typeof usage['input_tokens'] === 'number') {
          const turnInput = usage['input_tokens'] + cacheCreate + cacheRead;
          s.inputTokens += turnInput;
          s.lastInputTokens = turnInput;
        }
        if (typeof usage['output_tokens'] === 'number') {
          s.outputTokens += usage['output_tokens'];
          s.lastOutputTokens = usage['output_tokens'];
        }
        const speed = usage['speed'] as string | undefined;
        if (speed) { s.speed = speed; }

        const usageEffort = usage['reasoning_effort'] as string | undefined;
        if (usageEffort) { s.effort = usageEffort; }

        const latestInput = (usage['input_tokens'] as number | undefined) ?? 0;
        const totalContext = latestInput + cacheCreate + cacheRead;
        const limit = getContextLimit(s.model);
        s.contextPct = Math.min(100, Math.round((totalContext / limit) * 100));
      }

      const version = obj['version'] as string | undefined;
      if (version) { s.version = version; }

      const branch = obj['gitBranch'] as string | undefined;
      if (branch) { s.gitBranch = branch; }

      const cwd = obj['cwd'] as string | undefined;
      if (cwd) { s.cwd = cwd; }
    }

    return changed;
  }

  return changed;
}

/** Scan a JSONL file on disk for the most recent Read/Edit/Write file_paths. */
export function getRecentFilesFromLog(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const files: string[] = [];
    const seen = new Set<string>();

    for (const line of content.split('\n')) {
      if (!line.includes('"tool_use"')) { continue; }
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'assistant') { continue; }
        const blocks = obj.message?.content;
        if (!Array.isArray(blocks)) { continue; }
        for (const b of blocks) {
          if (b.type !== 'tool_use') { continue; }
          const name = b.name;
          if (name === 'Read' || name === 'Edit' || name === 'Write') {
            const fp = b.input?.file_path;
            if (fp && typeof fp === 'string') {
              const base = path.basename(fp);
              if (!seen.has(base)) {
                seen.add(base);
                files.push(base);
              }
            }
          }
        }
      } catch { /* skip */ }
    }
    return files.slice(-10);
  } catch { return []; }
}
