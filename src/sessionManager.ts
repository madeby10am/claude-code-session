import * as fs   from 'fs';
import * as path from 'path';

import {
  SessionEntry,
  SessionState,
  UsageStats,
  HUE_STEPS,
} from './session/types';
import {
  defaultSession,
  extractLastField,
  parseLines,
  getRecentFilesFromLog,
} from './session/jsonlParser';
import {
  computeUsageFromLogs as computeUsageFromLogsImpl,
} from './session/usageCompute';
import {
  CLAUDE_PROJECTS_DIR,
  CLAUDE_SETTINGS_PATH,
  getMcpServers as getMcpServersImpl,
  getSkills as getSkillsImpl,
  SkillInfo,
} from './session/claudeEnvironment';
import {
  clearEntryTimers,
  resetTimers,
} from './session/activityTimers';
import {
  getInstalledClis as getInstalledClisImpl,
  CliInfo,
} from './session/clis';

// Re-export types so existing imports (panel.ts, extension.ts) keep working.
export type { ActivityState, SessionState, UsageStats } from './session/types';

const HEAD_BYTES          = 1024;
const TAIL_BYTES          = 4096;
const ACTIVE_WINDOW_MS    = 60 * 60 * 1000;      // 1 hr: prune sessions older than this
const SEED_WINDOW_MS      = 60 * 60 * 1000;      // 1 hr: scan files this old at startup
const PRUNE_INTERVAL_MS   = 5 * 60 * 1000;       // 5 min
const SYNC_INTERVAL_MS    = 3 * 1000;            // 3  sec: detect deleted files
const DEBOUNCE_MS         = 100;

export class SessionManager {
  private readonly sessions: Map<string, SessionState> = new Map();
  private readonly entries:  Map<string, SessionEntry> = new Map();
  private readonly watchers: Map<string, fs.FSWatcher> = new Map();

  private hueIndex    = 0;
  private debounceId: ReturnType<typeof setTimeout>  | null = null;
  private pruneId:    ReturnType<typeof setInterval> | null = null;
  private syncId:     ReturnType<typeof setInterval> | null = null;
  private globalEffort = '';

  constructor(
    private readonly onUpdate: (sessions: Map<string, SessionState>) => void
  ) {
    this.init();
  }

  getSessions(): Map<string, SessionState> {
    return this.sessions;
  }

  getRecentFiles(sessionId?: string): string[] {
    const id = sessionId || this.getMostRecentSessionId();
    if (!id) { return []; }
    const entry = this.entries.get(id);
    if (!entry) { return []; }
    return getRecentFilesFromLog(entry.filePath);
  }

  getMcpServers(): string[] {
    return getMcpServersImpl();
  }

  getSkills(): SkillInfo[] {
    return getSkillsImpl();
  }

  getInstalledClis(): CliInfo[] {
    return getInstalledClisImpl();
  }

  getRecentSessions(): { sessionId: string; title: string; lastSeen: number; activity: string }[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .slice(0, 5)
      .map(s => ({
        sessionId: s.sessionId,
        title: s.chatTitle || s.projectName || s.slug,
        lastSeen: s.lastSeen,
        activity: s.activity,
      }));
  }

  computeUsageFromLogs(): UsageStats {
    return computeUsageFromLogsImpl();
  }

  private getMostRecentSessionId(): string | undefined {
    let best: SessionState | undefined;
    for (const s of this.sessions.values()) {
      if (!best || s.lastSeen > best.lastSeen) { best = s; }
    }
    return best?.sessionId;
  }

  dispose(): void {
    if (this.debounceId !== null) {
      clearTimeout(this.debounceId);
      this.debounceId = null;
    }
    if (this.pruneId !== null) {
      clearInterval(this.pruneId);
      this.pruneId = null;
    }
    if (this.syncId !== null) {
      clearInterval(this.syncId);
      this.syncId = null;
    }
    for (const entry of this.entries.values()) {
      clearEntryTimers(entry);
    }
    for (const [watchPath, watcher] of this.watchers.entries()) {
      try { watcher.close(); } catch { /* ignore */ }
      this.watchers.delete(watchPath);
    }
    this.entries.clear();
    this.sessions.clear();
  }

  private init(): void {
    try {
      if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) { return; }
    } catch {
      return;
    }

    try {
      const slugs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
      for (const slug of slugs) {
        const slugDir = path.join(CLAUDE_PROJECTS_DIR, slug);
        try {
          const stat = fs.statSync(slugDir);
          if (!stat.isDirectory()) { continue; }
        } catch { continue; }

        this.seedProjectDir(slug, slugDir);
        this.watchProjectDir(slug, slugDir);
      }
    } catch { /* ignore */ }

    this.readGlobalEffort();
    this.watchSettings();

    this.scheduleUpdate();

    this.watchProjectsRoot();

    this.pruneId = setInterval(() => this.pruneInactive(), PRUNE_INTERVAL_MS);
    this.syncId  = setInterval(() => this.syncDeletedFiles(), SYNC_INTERVAL_MS);
  }

  private readGlobalEffort(): void {
    try {
      const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const level = obj['effortLevel'] as string | undefined;
      if (level) { this.globalEffort = level; }
    } catch { /* file missing or invalid */ }
  }

  private watchSettings(): void {
    if (this.watchers.has(CLAUDE_SETTINGS_PATH)) { return; }
    try {
      const watcher = fs.watch(CLAUDE_SETTINGS_PATH, () => {
        const prev = this.globalEffort;
        this.readGlobalEffort();
        if (prev !== this.globalEffort) {
          for (const s of this.sessions.values()) {
            s.effort = this.globalEffort;
          }
          this.scheduleUpdate();
        }
      });
      watcher.on('error', () => {
        this.watchers.delete(CLAUDE_SETTINGS_PATH);
      });
      this.watchers.set(CLAUDE_SETTINGS_PATH, watcher);
    } catch { /* ignore */ }
  }

  private seedProjectDir(slug: string, slugDir: string): void {
    let jsonlFiles: string[] = [];
    try {
      jsonlFiles = fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl'));
    } catch { return; }

    const now = Date.now();

    for (const file of jsonlFiles) {
      const filePath = path.join(slugDir, file);
      try {
        const stat = fs.statSync(filePath);
        const age  = now - stat.mtimeMs;
        if (age > SEED_WINDOW_MS) { continue; }

        const size = stat.size;

        const fd = fs.openSync(filePath, 'r');
        let headRaw = '';
        let tailRaw = '';
        try {
          const headLen = Math.min(size, HEAD_BYTES);
          if (headLen > 0) {
            const headBuf = Buffer.alloc(headLen);
            fs.readSync(fd, headBuf, 0, headLen, 0);
            headRaw = headBuf.toString('utf8');
          }

          const tailStart = Math.max(0, size - TAIL_BYTES);
          if (tailStart > headLen) {
            const tailLen = size - tailStart;
            const tailBuf = Buffer.alloc(tailLen);
            fs.readSync(fd, tailBuf, 0, tailLen, tailStart);
            tailRaw = tailBuf.toString('utf8');
          }
        } finally {
          fs.closeSync(fd);
        }

        const sessionId = path.basename(file, '.jsonl');
        const hueShift  = this.nextHue();
        const state = defaultSession(sessionId, slug, hueShift);
        if (this.globalEffort) { state.effort = this.globalEffort; }
        const entry: SessionEntry = {
          state,
          fileOffset: size,
          filePath,
          idleTimer:  null,
          sleepTimer: null,
        };

        this.entries.set(sessionId, entry);
        this.sessions.set(sessionId, entry.state);

        const rekey = this.makeRekeyCallback(entry);
        parseLines(headRaw, entry, rekey);
        if (tailRaw) {
          parseLines(tailRaw, entry, rekey);
        }

        if (!entry.state.chatTitle) {
          this.scanForTitle(filePath, entry);
        }

        const lastSeenAge = now - entry.state.lastSeen;
        if (lastSeenAge > 2 * 60 * 1000) {
          entry.state.activity = 'sleeping';
        } else {
          resetTimers(entry, () => this.onEntryTimerChange(entry));
        }

      } catch { /* ignore bad file */ }
    }
  }

  private scanForTitle(filePath: string, entry: SessionEntry): void {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const title = extractLastField(content, '"custom-title"', 'customTitle')
                 ?? extractLastField(content, '"ai-title"', 'aiTitle');
      if (title) { entry.state.chatTitle = title; }
    } catch { /* file read error */ }
  }

  private watchProjectsRoot(): void {
    if (this.watchers.has(CLAUDE_PROJECTS_DIR)) { return; }
    try {
      const watcher = fs.watch(CLAUDE_PROJECTS_DIR, (event, filename) => {
        if (!filename) { return; }
        const slugDir = path.join(CLAUDE_PROJECTS_DIR, filename);
        try {
          const stat = fs.statSync(slugDir);
          if (!stat.isDirectory()) { return; }
        } catch { return; }

        if (!this.watchers.has(slugDir)) {
          this.watchProjectDir(filename, slugDir);
        }
      });

      watcher.on('error', () => {
        this.watchers.delete(CLAUDE_PROJECTS_DIR);
      });

      this.watchers.set(CLAUDE_PROJECTS_DIR, watcher);
    } catch { /* ignore */ }
  }

  private watchProjectDir(slug: string, slugDir: string): void {
    if (this.watchers.has(slugDir)) { return; }
    try {
      const watcher = fs.watch(slugDir, (event, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) { return; }
        const filePath = path.join(slugDir, filename);
        this.handleFileChange(slug, filePath);
      });

      watcher.on('error', () => {
        this.watchers.delete(slugDir);
      });

      this.watchers.set(slugDir, watcher);
    } catch { /* ignore */ }
  }

  private handleFileChange(slug: string, filePath: string): void {
    const sessionId = path.basename(filePath, '.jsonl');

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        this.removeSession(sessionId);
        return;
      }
    } catch {
      this.removeSession(sessionId);
      return;
    }

    try {
      let entry = this.entries.get(sessionId);

      if (!entry) {
        const hueShift = this.nextHue();
        const state = defaultSession(sessionId, slug, hueShift);
        if (this.globalEffort) { state.effort = this.globalEffort; }
        entry = {
          state,
          fileOffset: 0,
          filePath,
          idleTimer:  null,
          sleepTimer: null,
        };
        this.entries.set(sessionId, entry);
        this.sessions.set(sessionId, entry.state);
      }

      const size = stat.size;

      if (size < entry.fileOffset) {
        entry.fileOffset = 0;
      }

      const readStart  = entry.fileOffset;
      const readLength = size - readStart;

      if (readLength <= 0) { return; }

      const buf = Buffer.alloc(readLength);
      const fd  = fs.openSync(filePath, 'r');
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(fd, buf, 0, readLength, readStart);
      } finally {
        fs.closeSync(fd);
      }

      entry.fileOffset = readStart + bytesRead;

      const raw = buf.slice(0, bytesRead).toString('utf8');
      const changed = parseLines(raw, entry, this.makeRekeyCallback(entry));

      if (changed) {
        resetTimers(entry, () => this.onEntryTimerChange(entry));
        this.scheduleUpdate();
      }

    } catch { /* ignore */ }
  }

  private removeSession(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) { return; }
    clearEntryTimers(entry);
    this.entries.delete(sessionId);
    this.sessions.delete(sessionId);
    this.scheduleUpdate();
  }

  private onEntryTimerChange(entry: SessionEntry): void {
    this.sessions.set(entry.state.sessionId, entry.state);
    this.scheduleUpdate();
  }

  private makeRekeyCallback(entry: SessionEntry): (oldId: string, newId: string) => void {
    return (oldId, newId) => {
      this.entries.delete(oldId);
      this.sessions.delete(oldId);
      this.entries.set(newId, entry);
      this.sessions.set(newId, entry.state);
    };
  }

  private pruneInactive(): void {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    let changed = false;
    for (const [id, entry] of this.entries.entries()) {
      try {
        if (!fs.existsSync(entry.filePath)) {
          this.removeSession(id);
          changed = true;
          continue;
        }
      } catch { /* ignore */ }

      if (entry.state.lastSeen < cutoff) {
        clearEntryTimers(entry);
        this.entries.delete(id);
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) { this.scheduleUpdate(); }
  }

  private syncDeletedFiles(): void {
    let changed = false;
    for (const [id, entry] of this.entries.entries()) {
      try {
        if (!fs.existsSync(entry.filePath)) {
          clearEntryTimers(entry);
          this.entries.delete(id);
          this.sessions.delete(id);
          changed = true;
        }
      } catch { /* ignore */ }
    }
    if (changed) {
      this.scheduleUpdate();
    }
  }

  private scheduleUpdate(): void {
    if (this.debounceId !== null) { return; }
    this.debounceId = setTimeout(() => {
      this.debounceId = null;
      try {
        this.onUpdate(this.sessions);
      } catch { /* caller errors must not crash us */ }
    }, DEBOUNCE_MS);
  }

  private nextHue(): number {
    return HUE_STEPS[this.hueIndex++ % HUE_STEPS.length];
  }
}
