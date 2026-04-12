import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ActivityState =
  | 'idle'
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
  inputTokens:    number;
  outputTokens:   number;
  cacheTokens:    number;
  contextPct:     number;
  currentFile:    string;
  turnCount:      number;
  toolUseCount:   number;
  lastAction:     string;
  activity:       ActivityState;
  lastSeen:       number;
  startedAt:      number;
  hueShift:       number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR  = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES            = 1024;
const TAIL_BYTES            = 4096;
const ACTIVE_WINDOW_MS      = 10 * 60 * 1000;   // 10 min
const IDLE_TIMEOUT_MS       = 10 * 1000;         // 10 sec: responding → idle
const SLEEP_TIMEOUT_MS      = 2  * 60 * 1000;   // 2  min: idle → sleeping
const PRUNE_INTERVAL_MS     = 5  * 60 * 1000;   // 5  min
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
    inputTokens:    0,
    outputTokens:   0,
    cacheTokens:    0,
    contextPct:     0,
    currentFile:    '',
    turnCount:      0,
    toolUseCount:   0,
    lastAction:     '',
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

  constructor(
    private readonly onUpdate: (sessions: Map<string, SessionState>) => void
  ) {
    this.init();
  }

  getSessions(): Map<string, SessionState> {
    return this.sessions;
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

    // Cancel all timers
    for (const entry of this.entries.values()) {
      if (entry.idleTimer !== null) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      if (entry.sleepTimer !== null) {
        clearTimeout(entry.sleepTimer);
        entry.sleepTimer = null;
      }
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

    // Emit seeded state so webview gets data immediately
    this.scheduleUpdate();

    // Watch projects root for new project dirs appearing
    this.watchProjectsRoot();

    // Periodic prune sweep
    this.pruneId = setInterval(() => this.pruneInactive(), PRUNE_INTERVAL_MS);
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
        if (age > ACTIVE_WINDOW_MS) { continue; }

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
        const entry: SessionEntry = {
          state:      defaultSession(sessionId, slug, hueShift),
          fileOffset: size,
          filePath,
          idleTimer:  null,
          sleepTimer: null,
        };

        this.entries.set(sessionId, entry);
        this.sessions.set(sessionId, entry.state);

        // Parse head first (catches ai-title), then tail (recent activity)
        this.parseLines(headRaw, entry);
        if (tailRaw) {
          this.parseLines(tailRaw, entry);
        }

        // Start sleep timer
        this.resetTimers(entry);

      } catch { /* ignore bad file */ }
    }
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
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) { return; }

      // Find or create session entry for this file
      const sessionId = path.basename(filePath, '.jsonl');
      let entry = this.entries.get(sessionId);

      if (!entry) {
        const hueShift = this.nextHue();
        entry = {
          state:      defaultSession(sessionId, slug, hueShift),
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
        this.pruneInactive();
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
      s.lastSeen = Date.now();
      changed = true;
    }

    // Extract entrypoint from any entry that carries it
    const entrypoint = obj['entrypoint'] as string | undefined;
    if (entrypoint && !s.entrypoint) {
      s.entrypoint = entrypoint;
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

      if (!hasToolResult) {
        s.activity = 'user_sent';
        s.lastSeen = Date.now();
        s.turnCount++;
        changed = true;
      }
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

        // Extract model
        const model = (message?.['model'] ?? obj['model']) as string | undefined;
        if (model) { s.model = model; }

        // Extract usage (accumulate across messages)
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

          // Extract speed
          const speed = usage['speed'] as string | undefined;
          if (speed) { s.speed = speed; }
        }

        // Recompute contextPct: total context = input + cache_read + cache_creation
        if (usage) {
          const inp   = (usage['input_tokens']                  as number | undefined) ?? 0;
          const cRead = (usage['cache_read_input_tokens']       as number | undefined) ?? 0;
          const cCreate = (usage['cache_creation_input_tokens'] as number | undefined) ?? 0;
          const totalContext = inp + cRead + cCreate;
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
  // Idle + sleep timers
  // -------------------------------------------------------------------------

  private resetTimers(entry: SessionEntry): void {
    // Clear existing timers
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.sleepTimer !== null) {
      clearTimeout(entry.sleepTimer);
      entry.sleepTimer = null;
    }

    // After 10s of no new data → idle
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.state.activity !== 'sleeping') {
        entry.state.activity = 'idle';
        this.sessions.set(entry.state.sessionId, entry.state);
        this.scheduleUpdate();
      }
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
      if (entry.state.lastSeen < cutoff) {
        if (entry.idleTimer !== null) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        if (entry.sleepTimer !== null) {
          clearTimeout(entry.sleepTimer);
          entry.sleepTimer = null;
        }
        this.entries.delete(id);
        this.sessions.delete(id);
      }
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
