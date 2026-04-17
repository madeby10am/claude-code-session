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

const CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-6':   1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5':  200_000,
};

export function getContextLimit(model: string): number {
  return CONTEXT_LIMITS[model] ?? 200_000;
}

export const HUE_STEPS = [0, 45, 120, 200, 270, 330, 160, 80];
