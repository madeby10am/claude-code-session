export type ActivityState =
  | 'idle'
  | 'thinking'
  | 'user_sent'
  | 'tooling'
  | 'responding'
  | 'sleeping';

export interface SessionState {
  sessionId:      string;
  slug:           string;
  projectName:    string;
  chatTitle:      string;
  cwd:            string;
  gitBranch:      string;
  model:          string;
  version:        string;
  entrypoint:     string;
  permissionMode: string;
  speed:          string;
  effort:         string;
  inputTokens:    number;
  outputTokens:   number;
  lastInputTokens:  number;
  lastOutputTokens: number;
  contextPct:     number;
  currentFile:    string;
  turnCount:      number;
  toolUseCount:   number;
  lastAction:     string;
  needsInput:     boolean;
  activity:       ActivityState;
  lastSeen:       number;
  startedAt:      number;
  hueShift:       number;
}

export interface UsageStats {
  sessionPct:       number;
  weeklyPct:        number;
  sessionResetMs:   number;
  weeklyResetMs:    number;
  sessionWindowMs:  number;
  weeklyWindowMs:   number;
  live:             boolean;
  planTier:         string;
  overageInUse:     boolean;
}

export interface SessionEntry {
  state:       SessionState;
  fileOffset:  number;
  filePath:    string;
  idleTimer:   ReturnType<typeof setTimeout> | null;
  sleepTimer:  ReturnType<typeof setTimeout> | null;
  // One API response is written as several JSONL lines sharing a message.id,
  // each repeating the same usage — count usage once per id.
  lastUsageMsgId?: string;
}

// Pattern-match the model family so new versions work without a code change.
// 1M context: Fable/Mythos 5, Opus 4.6+, Sonnet 4.6+ (and Sonnet 5).
// 200K: Haiku (all), and older Opus/Sonnet (4.5, 4.1, 4.0, 3.x).
export function getContextLimit(model: string): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 200_000;
  if (m.includes('fable') || m.includes('mythos')) return 1_000_000;
  if (m.includes('opus') || m.includes('sonnet')) {
    const ver = m.match(/-(\d+)-(\d+)/);
    if (!ver) return 1_000_000; // e.g. "claude-sonnet-5" — current generation
    const major = parseInt(ver[1], 10);
    const minor = parseInt(ver[2], 10);
    return major > 4 || (major === 4 && minor >= 6) ? 1_000_000 : 200_000;
  }
  return 200_000;
}

export const HUE_STEPS = [0, 45, 120, 200, 270, 330, 160, 80];
