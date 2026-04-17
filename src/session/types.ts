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
}

// Pattern-match the model family so new minor versions (opus-4-7, sonnet-4-8, …) work
// without a code change. Haiku is the small-context outlier.
export function getContextLimit(model: string): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 200_000;
  if (m.includes('opus') || m.includes('sonnet')) return 1_000_000;
  return 200_000;
}

export const HUE_STEPS = [0, 45, 120, 200, 270, 330, 160, 80];
