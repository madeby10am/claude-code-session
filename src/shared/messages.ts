// Typed message envelopes shared by panel.ts (extension side) and src/webview/ (webview side).
// Keep the type strings in sync on both sides so TypeScript can narrow correctly.

import type { SessionState, UsageStats } from '../session/types';
import type { SkillCategory } from '../session/categorize';
import type { CliInfo } from '../session/clis';
import type { TokenEvent } from '../session/tokenActivity';
import type { GitActivity } from '../session/gitActivity';

export interface ProjectInfo {
  workspace:        string;
  workspacePath:    string;
  activeFile:       string;
  gitBranch:        string;
  gitRemote:        string;
  gitLastCommit:    string;
  uncommittedCount: number;
  ahead:            number;
  behind:           number;
  stashCount:       number;
  isPrivate:        boolean | null;
  openIssues:       number;
  openPRs:          number;
  activity:         GitActivity[];
}

export interface EnvData {
  recentFiles:    string[];
  mcpServers:     string[];
  recentSessions: { sessionId: string; title: string; lastSeen: number; activity: string }[];
  skills:         { name: string; source: string; description: string; category: SkillCategory }[];
  clis:           CliInfo[];
}

export type ExtensionToWebview =
  | { type: 'sessionsUpdate'; sessions: SessionState[] }
  | { type: 'projectInfo';    data: ProjectInfo }
  | { type: 'envData';        data: EnvData }
  | { type: 'usageUpdate';    usage: UsageStats }
  | { type: 'tokenActivity';  events: TokenEvent[]; windowHours: number }
  | { type: 'focusSession';   sessionId: string };

export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'refreshUsage' }
  | { type: 'refreshTokenActivity' }
  | { type: 'openUrl';     url: string }
  | { type: 'openFile';    file: string }
  | { type: 'openFolder';  path: string }
  | { type: 'inputSkill';  name: string }
  | { type: 'openSession'; sessionId: string }
  | { type: 'dismissSession'; sessionId: string }
  | { type: 'newSession' };
