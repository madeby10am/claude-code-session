import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  cacheTokens:    number;
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
  today: { outputTokens: number };
  week:  { outputTokens: number };
  claudeUsage: {
    sessionPercentage: number;
    sessionTokensUsed: number;
    sessionLimit: number;
    sessionResetTime: number;
    weeklyPercentage: number;
    weeklyTokensUsed: number;
    weeklyLimit: number;
    weeklyResetTime: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_DIR            = path.join(os.homedir(), '.claude');
const CLAUDE_PROJECTS_DIR  = path.join(CLAUDE_DIR, 'projects');
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const HEAD_BYTES            = 1024;
const TAIL_BYTES            = 4096;
const ACTIVE_WINDOW_MS      = 60 * 60 * 1000;      // 1 hr: prune sessions older than this
const SEED_WINDOW_MS        = 60 * 60 * 1000;      // 1 hr: scan files this old at startup
const IDLE_TIMEOUT_MS       = 10 * 1000;            // 10 sec: responding → idle
const SLEEP_TIMEOUT_MS      = 2  * 60 * 1000;       // 2  min: idle → sleeping
const PRUNE_INTERVAL_MS     = 5  * 60 * 1000;       // 5  min
const SYNC_INTERVAL_MS      = 3  * 1000;            // 3  sec: detect deleted files
const DEBOUNCE_MS           = 100;

const CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-6':   1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5':  200_000,
};

function getContextLimit(model: string): number {
  return CONTEXT_LIMITS[model] ?? 200_000;
}

const HUE_STEPS = [0, 45, 120, 200, 270, 330, 160, 80];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toProjectName(slug: string): string {
  const parts = slug.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean).slice(-3);
  return meaningful
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function defaultSession(
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
    cacheTokens:    0,
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

function humanizeToolUse(name: string, input: Record<string, unknown>): string {
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

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

interface SessionEntry {
  state:       SessionState;
  fileOffset:  number;
  filePath:    string;
  idleTimer:   ReturnType<typeof setTimeout> | null;
  sleepTimer:  ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly sessions: Map<string, SessionState>    = new Map();
  private readonly entries:  Map<string, SessionEntry>    = new Map();

  /** fs.watch handles keyed by the path being watched */
  private readonly watchers: Map<string, fs.FSWatcher>    = new Map();

  private hueIndex   = 0;
  private debounceId: ReturnType<typeof setTimeout> | null = null;
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
    // Find the most recent session if no ID given
    const id = sessionId || this.getMostRecentSessionId();
    if (!id) { return []; }

    const entry = this.entries.get(id);
    if (!entry) { return []; }

    try {
      const content = fs.readFileSync(entry.filePath, 'utf-8');
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

  getMcpServers(): string[] {
    const servers: string[] = [];
    try {
      const globalMcp = path.join(CLAUDE_DIR, 'mcp.json');
      if (fs.existsSync(globalMcp)) {
        const data = JSON.parse(fs.readFileSync(globalMcp, 'utf-8'));
        if (data.mcpServers) {
          servers.push(...Object.keys(data.mcpServers));
        }
      }
    } catch { /* ignore */ }
    return servers;
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

  private getMostRecentSessionId(): string | undefined {
    let best: SessionState | undefined;
    for (const s of this.sessions.values()) {
      if (!best || s.lastSeen > best.lastSeen) { best = s; }
    }
    return best?.sessionId;
  }

  computeUsageFromLogs(): UsageStats {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart  = todayStart - 6 * 24 * 60 * 60 * 1000;

    let todayOut = 0;
    let weekOut  = 0;

    try {
      const slugs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
      for (const slug of slugs) {
        const slugDir = path.join(CLAUDE_PROJECTS_DIR, slug);
        try {
          if (!fs.statSync(slugDir).isDirectory()) { continue; }
        } catch { continue; }

        let files: string[];
        try { files = fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl')); }
        catch { continue; }

        for (const file of files) {
          const filePath = path.join(slugDir, file);
          try {
            const mtime = fs.statSync(filePath).mtimeMs;
            if (mtime < weekStart) { continue; } // skip old files

            const content = fs.readFileSync(filePath, 'utf-8');
            for (const line of content.split('\n')) {
              if (!line.includes('"output_tokens"')) { continue; }
              try {
                const entry = JSON.parse(line);
                if (entry.type !== 'assistant' || !entry.message?.usage?.output_tokens) { continue; }
                const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : mtime;
                const out = entry.message.usage.output_tokens as number;
                if (ts >= todayStart) { todayOut += out; }
                if (ts >= weekStart)  { weekOut  += out; }
              } catch { /* skip unparseable lines */ }
            }
          } catch { continue; }
        }
      }
    } catch { /* projects dir missing */ }

    return {
      today: { outputTokens: todayOut },
      week:  { outputTokens: weekOut },
      claudeUsage: this.readClaudeUsagePlist(),
    };
  }

  private readClaudeUsagePlist(): UsageStats['claudeUsage'] {
    try {
      const plistPath = path.join(
        os.homedir(), 'Library', 'Preferences',
        'HamedElfayome.Claude-Usage.plist'
      );
      if (!fs.existsSync(plistPath)) { return null; }

      // Use plutil to convert binary plist to JSON, then extract profiles_v3
      const { execSync } = require('child_process');
      const raw = execSync(
        `plutil -p "${plistPath}" -o /dev/null 2>/dev/null; python3 -c "
import plistlib, json, sys
with open('${plistPath}', 'rb') as f:
    p = plistlib.load(f)
profiles = json.loads(p.get('profiles_v3', b'[]'))
for prof in profiles:
    cu = prof.get('claudeUsage')
    if cu:
        print(json.dumps(cu))
        sys.exit(0)
"`,
        { encoding: 'utf8', timeout: 3000 }
      ).trim();

      if (!raw) { return null; }
      const cu = JSON.parse(raw);
      return {
        sessionPercentage: cu.sessionPercentage ?? 0,
        sessionTokensUsed: cu.sessionTokensUsed ?? 0,
        sessionLimit:      cu.sessionLimit ?? 0,
        sessionResetTime:  cu.sessionResetTime ?? 0,
        weeklyPercentage:  cu.weeklyPercentage ?? 0,
        weeklyTokensUsed:  cu.weeklyTokensUsed ?? 0,
        weeklyLimit:       cu.weeklyLimit ?? 0,
        weeklyResetTime:   cu.weeklyResetTime ?? 0,
      };
    } catch { return null; }
  }

  dispose(): void {
    // Cancel debounce
    if (this.debounceId !== null) {
      clearTimeout(this.debounceId);
      this.debounceId = null;
    }

    // Cancel prune sweep
    if (this.pruneId !== null) {
      clearInterval(this.pruneId);
      this.pruneId = null;
    }

    // Cancel sync sweep
    if (this.syncId !== null) {
      clearInterval(this.syncId);
      this.syncId = null;
    }

    // Cancel all timers
    for (const entry of this.entries.values()) {
      this.clearEntryTimers(entry);
    }

    // Close all fs.watch handles
    for (const [watchPath, watcher] of this.watchers.entries()) {
      try { watcher.close(); } catch { /* ignore */ }
      this.watchers.delete(watchPath);
    }

    this.entries.clear();
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  private init(): void {
    // If projects dir doesn't exist, bail silently
    try {
      if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) { return; }
    } catch {
      return;
    }

    // Startup scan
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

    // Read global effort from settings
    this.readGlobalEffort();
    this.watchSettings();

    // Emit seeded state so webview gets data immediately
    this.scheduleUpdate();

    // Watch projects root for new project dirs appearing
    this.watchProjectsRoot();

    // Periodic prune sweep
    this.pruneId = setInterval(() => this.pruneInactive(), PRUNE_INTERVAL_MS);

    // Fast sync: detect deleted files every 3s
    this.syncId = setInterval(() => this.syncDeletedFiles(), SYNC_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // Global settings (effort level)
  // -------------------------------------------------------------------------

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
          // Apply to all active sessions
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

  // -------------------------------------------------------------------------
  // Seeding (startup)
  // -------------------------------------------------------------------------

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

        // Read head (for ai-title) and tail (for recent state)
        const fd = fs.openSync(filePath, 'r');
        let headRaw = '';
        let tailRaw = '';
        try {
          // Head: first HEAD_BYTES
          const headLen = Math.min(size, HEAD_BYTES);
          if (headLen > 0) {
            const headBuf = Buffer.alloc(headLen);
            fs.readSync(fd, headBuf, 0, headLen, 0);
            headRaw = headBuf.toString('utf8');
          }

          // Tail: last TAIL_BYTES (skip if file small enough that head covers it)
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

        // Derive sessionId from filename (without extension)
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

        // Parse head first, then tail (recent activity)
        this.parseLines(headRaw, entry);
        if (tailRaw) {
          this.parseLines(tailRaw, entry);
        }

        // ai-title can appear anywhere in the file — scan for it if not found
        if (!entry.state.chatTitle) {
          this.scanForTitle(filePath, entry);
        }

        // Set correct initial activity based on how old the last entry actually is
        const lastSeenAge = now - entry.state.lastSeen;
        if (lastSeenAge > SLEEP_TIMEOUT_MS) {
          entry.state.activity = 'sleeping';
          // No timers — prune sweep will remove it once past ACTIVE_WINDOW_MS
        } else {
          this.resetTimers(entry);
        }

      } catch { /* ignore bad file */ }
    }
  }

  /**
   * Scan an entire JSONL file for the last ai-title line.
   * Reads the raw file as a string and searches for ai-title entries
   * so we don't miss titles that fall outside the head/tail windows.
   */
  private scanForTitle(filePath: string, entry: SessionEntry): void {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const marker = '"ai-title"';
      let lastIdx = content.lastIndexOf(marker);
      if (lastIdx === -1) { return; }

      // Walk back to find the start of this line
      const lineStart = content.lastIndexOf('\n', lastIdx) + 1;
      const lineEnd   = content.indexOf('\n', lastIdx);
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
      if (!line) { return; }

      try {
        const obj = JSON.parse(line);
        const title = obj['aiTitle'] as string | undefined;
        if (title) {
          entry.state.chatTitle = title;
        }
      } catch { /* malformed line */ }
    } catch { /* file read error */ }
  }

  // -------------------------------------------------------------------------
  // Watching
  // -------------------------------------------------------------------------

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

        // New project dir
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

  // -------------------------------------------------------------------------
  // File change handler
  // -------------------------------------------------------------------------

  private handleFileChange(slug: string, filePath: string): void {
    const sessionId = path.basename(filePath, '.jsonl');

    // Detect file deletion — remove session if the file is gone
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        this.removeSession(sessionId);
        return;
      }
    } catch {
      // File doesn't exist anymore — it was deleted
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

      // Handle truncation / replacement
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
      const changed = this.parseLines(raw, entry);

      if (changed) {
        this.resetTimers(entry);
        this.scheduleUpdate();
      }

    } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // JSONL parsing
  // -------------------------------------------------------------------------

  private parseLines(raw: string, entry: SessionEntry): boolean {
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
        continue; // skip malformed
      }

      if (this.applyEntry(obj, entry)) {
        changed = true;
      }
    }

    return changed;
  }

  private applyEntry(
    obj:   Record<string, unknown>,
    entry: SessionEntry
  ): boolean {
    let changed = false;
    const s = entry.state;

    // Update sessionId / lastSeen from any entry that carries them
    if (typeof obj['sessionId'] === 'string' && obj['sessionId']) {
      const newId = obj['sessionId'] as string;
      if (newId !== s.sessionId) {
        // Re-key in maps
        this.entries.delete(s.sessionId);
        this.sessions.delete(s.sessionId);
        s.sessionId = newId;
        this.entries.set(newId, entry);
        this.sessions.set(newId, s);
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

    // Extract entrypoint from any entry that carries it
    const entrypoint = obj['entrypoint'] as string | undefined;
    if (entrypoint && !s.entrypoint) {
      s.entrypoint = entrypoint;
      changed = true;
    }

    // Extract effort from top-level fields
    const effort = (obj['reasoningEffort'] ?? obj['reasoning_effort']) as string | undefined;
    if (effort) {
      s.effort = effort;
      changed = true;
    }

    const type = obj['type'] as string | undefined;

    // -----------------------------------------------------------------------
    // ai-title (chat name)
    // -----------------------------------------------------------------------
    if (type === 'ai-title') {
      const title = obj['aiTitle'] as string | undefined;
      if (title) {
        s.chatTitle = title;
        changed = true;
      }
      return changed;
    }

    // -----------------------------------------------------------------------
    // file-history-snapshot
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // user message
    // -----------------------------------------------------------------------
    if (type === 'user') {
      // Extract permission mode
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

    // -----------------------------------------------------------------------
    // assistant message
    // -----------------------------------------------------------------------
    if (type === 'assistant') {
      const message    = obj['message']    as Record<string, unknown> | undefined;
      const stopReason = (message?.['stop_reason'] ?? obj['stop_reason']) as string | undefined;

      // Count tool_use blocks and extract last action
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

        // Detect if Claude is asking a question or presenting choices
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
            /^\s*\d+[.)]\s+\S/m.test(lastText); // numbered list options
          s.needsInput = isQuestion;
        }

        // Extract model
        const model = (message?.['model'] ?? obj['model']) as string | undefined;
        if (model) { s.model = model; }

        const usage = (message?.['usage'] ?? obj['usage']) as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage['input_tokens'] === 'number') {
            s.inputTokens += usage['input_tokens'];
          }
          if (typeof usage['output_tokens'] === 'number') {
            s.outputTokens += usage['output_tokens'];
          }
          const cacheCreate = (usage['cache_creation_input_tokens'] as number | undefined) ?? 0;
          const cacheRead   = (usage['cache_read_input_tokens']     as number | undefined) ?? 0;
          s.cacheTokens += cacheCreate + cacheRead;

          const speed = usage['speed'] as string | undefined;
          if (speed) { s.speed = speed; }

          const effort = usage['reasoning_effort'] as string | undefined;
          if (effort) { s.effort = effort; }

          const latestInput = (usage['input_tokens'] as number | undefined) ?? 0;
          const totalContext = latestInput + cacheCreate + cacheRead;
          const limit = getContextLimit(s.model);
          s.contextPct = Math.min(100, Math.round((totalContext / limit) * 100));
        }

        // version
        const version = obj['version'] as string | undefined;
        if (version) { s.version = version; }

        // gitBranch
        const branch = obj['gitBranch'] as string | undefined;
        if (branch) { s.gitBranch = branch; }

        // cwd
        const cwd = obj['cwd'] as string | undefined;
        if (cwd) { s.cwd = cwd; }
      }

      return changed;
    }

    return changed;
  }

  // -------------------------------------------------------------------------
  // Session removal (file deleted)
  // -------------------------------------------------------------------------

  private removeSession(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) { return; }
    this.clearEntryTimers(entry);
    this.entries.delete(sessionId);
    this.sessions.delete(sessionId);
    this.scheduleUpdate();
  }

  // -------------------------------------------------------------------------
  // Idle + sleep timers
  // -------------------------------------------------------------------------

  private clearEntryTimers(entry: SessionEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.sleepTimer !== null) {
      clearTimeout(entry.sleepTimer);
      entry.sleepTimer = null;
    }
  }

  private resetTimers(entry: SessionEntry): void {
    this.clearEntryTimers(entry);

    // After 10s of no new data → thinking (if actively working) or idle
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.state.activity === 'sleeping') { return; }
      // user_sent and tooling both mean Claude is mid-work — stay in thinking
      if (entry.state.activity === 'user_sent' || entry.state.activity === 'tooling') {
        entry.state.activity = 'thinking';
      } else if (entry.state.activity !== 'thinking') {
        // responding → idle (turn is done), anything else → idle
        entry.state.activity = 'idle';
      }
      this.sessions.set(entry.state.sessionId, entry.state);
      this.scheduleUpdate();
    }, IDLE_TIMEOUT_MS);

    // After 5min of no new data → sleeping
    entry.sleepTimer = setTimeout(() => {
      entry.sleepTimer = null;
      entry.state.activity = 'sleeping';
      this.sessions.set(entry.state.sessionId, entry.state);
      this.scheduleUpdate();
    }, SLEEP_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------
  // Inactive pruning
  // -------------------------------------------------------------------------

  private pruneInactive(): void {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    for (const [id, entry] of this.entries.entries()) {
      // Remove if the backing file no longer exists (chat was deleted)
      try {
        if (!fs.existsSync(entry.filePath)) {
          this.removeSession(id);
          continue;
        }
      } catch { /* ignore */ }

      if (entry.state.lastSeen < cutoff) {
        this.clearEntryTimers(entry);
        this.entries.delete(id);
        this.sessions.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fast sync: detect deleted JSONL files
  // -------------------------------------------------------------------------

  private syncDeletedFiles(): void {
    let changed = false;
    for (const [id, entry] of this.entries.entries()) {
      try {
        if (!fs.existsSync(entry.filePath)) {
          this.clearEntryTimers(entry);
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

  // -------------------------------------------------------------------------
  // Debounced update emission
  // -------------------------------------------------------------------------

  private scheduleUpdate(): void {
    if (this.debounceId !== null) { return; }
    this.debounceId = setTimeout(() => {
      this.debounceId = null;
      try {
        this.onUpdate(this.sessions);
      } catch { /* caller errors must not crash us */ }
    }, DEBOUNCE_MS);
  }

  // -------------------------------------------------------------------------
  // Hue assignment
  // -------------------------------------------------------------------------

  private nextHue(): number {
    return HUE_STEPS[this.hueIndex++ % HUE_STEPS.length];
  }
}
