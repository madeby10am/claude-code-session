import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { SessionState } from './sessionManager';

export class Panel implements vscode.WebviewViewProvider {
  private static instance: Panel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private sidebarView: vscode.WebviewView | undefined;
  private sessions: Map<string, SessionState> = new Map();
  private disposables: vscode.Disposable[] = [];
  private context: vscode.ExtensionContext;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  static createProvider(context: vscode.ExtensionContext): Panel {
    if (!Panel.instance) {
      Panel.instance = new Panel(context);
    }
    return Panel.instance;
  }

  static getInstance(): Panel | undefined {
    return Panel.instance;
  }

  // WebviewViewProvider — called by VS Code when the sidebar view is shown
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.sidebarView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();

    webviewView.webview.onDidReceiveMessage((msg: { type: string; value?: boolean }) => {
      if (msg.type === 'ready') {
        this.sendSessions(this.sessions);
        this.sendProjectInfo();
        this.sendTabNames();
        this.sendDarkMode();
      }
      if (msg.type === 'setDarkMode') {
        this.context.workspaceState.update('darkMode', msg.value);
      }
    });

    webviewView.onDidDispose(() => {
      this.sidebarView = undefined;
    });

    this.registerListeners();
  }

  // Open as editor panel (legacy command)
  openAsPanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'pixelAgent',
      'Claude Sessions',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage((msg: { type: string; value?: boolean }) => {
      if (msg.type === 'ready') {
        this.sendSessions(this.sessions);
        this.sendProjectInfo();
        this.sendTabNames();
        this.sendDarkMode();
      }
      if (msg.type === 'setDarkMode') {
        this.context.workspaceState.update('darkMode', msg.value);
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.registerListeners();
  }

  private registerListeners(): void {
    // Avoid duplicate listeners
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.sendProjectInfo();
      })
    );

    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.sendTabNames();
      })
    );
  }

  private postMessage(msg: unknown): void {
    this.sidebarView?.webview.postMessage(msg);
    this.panel?.webview.postMessage(msg);
  }

  private sendDarkMode(): void {
    const dark = this.context.workspaceState.get<boolean>('darkMode', false);
    this.postMessage({ type: 'darkMode', value: dark });
  }

  sendSessions(sessions: Map<string, SessionState>): void {
    this.sessions = sessions;
    this.postMessage({
      type: 'sessionsUpdate',
      sessions: Array.from(sessions.values()),
    });
  }

  sendProjectInfo(): void {
    const editor = vscode.window.activeTextEditor;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const cwd = workspaceFolder?.uri.fsPath ?? '';

    let gitBranch = '';
    let gitRemote = '';
    let gitUser = '';
    let gitLastCommit = '';

    if (cwd) {
      try {
        gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim();
      } catch { /* not a git repo */ }
      try {
        const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf8' }).trim();
        const match = remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
        gitRemote = match ? match[1] : remote;
      } catch { /* no remote */ }
      try {
        gitUser = execSync('git config user.name', { cwd, encoding: 'utf8' }).trim();
      } catch { /* ignore */ }
      try {
        gitLastCommit = execSync('git log -1 --format=%s', { cwd, encoding: 'utf8' }).trim();
      } catch { /* ignore */ }
    }

    this.postMessage({
      type: 'projectInfo',
      data: {
        workspace: workspaceFolder?.name ?? '',
        activeFile: editor
          ? vscode.workspace.asRelativePath(editor.document.uri)
          : '',
        gitBranch,
        gitRemote,
        gitUser,
        gitLastCommit,
      },
    });
  }

  sendTabNames(): void {
    const tabNames: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        tabNames.push(tab.label);
      }
    }

    this.postMessage({
      type: 'tabNames',
      names: tabNames,
    });
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.panel?.dispose();
  }

  private buildHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
/* ===== Reset & Base ===== */
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: 100%; height: 100%;
  background: #ffffff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  color: #1a1a1a;
  -webkit-font-smoothing: antialiased;
}
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #d4d4d4; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #b0b0b0; }

#root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: 0;
}

/* ===== Header ===== */
.header {
  padding: 8px 16px;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  gap: 12px;
}
.header-left {
  display: flex; align-items: center; gap: 6px;
  min-width: 0;
}
.header-right {
  flex-shrink: 0;
}
.header-project {
  font-size: 12px; font-weight: 600; color: #18181b;
  white-space: nowrap;
}
.header-git-item {
  font-size: 10px; color: #737373;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  white-space: nowrap;
}
.header-git-sep {
  font-size: 10px; color: #d4d4d4;
}

/* ===== Section chrome ===== */
.section {
  border-bottom: 1px solid #f0f0f0;
}
.section-header {
  padding: 12px 20px 8px;
  font-size: 10px;
  font-weight: 600;
  color: #a0a0a0;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  user-select: none;
}
.section-body {
  padding: 0 20px 14px;
}

/* ===== Active Sessions (hero) ===== */
.session-card {
  background: #fafafa;
  border: 1px solid #ebebeb;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 8px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.session-card:last-child { margin-bottom: 0; }
.session-card:hover {
  border-color: #d0d0d0;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}

/* Activity border accent */
.session-card[data-activity="tooling"]    { border-left: 3px solid #3b82f6; }
.session-card[data-activity="user_sent"]  { border-left: 3px solid #f59e0b; }
.session-card[data-activity="responding"] { border-left: 3px solid #10b981; }
.session-card[data-activity="sleeping"]   { border-left: 3px solid #9ca3af; }
.session-card[data-activity="idle"]       { border-left: 3px solid #d4d4d4; }

.card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

/* Animated status dot */
.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #d4d4d4;
  position: relative;
}
.status-dot::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  background: inherit;
  opacity: 0;
}
@keyframes pulse {
  0%, 100% { opacity: 0; transform: scale(0.8); }
  50% { opacity: 0.4; transform: scale(1); }
}
.status-dot[data-active="true"]::after {
  animation: pulse 2s ease-in-out infinite;
}
.status-dot[data-status="tooling"]    { background: #3b82f6; }
.status-dot[data-status="user_sent"]  { background: #f59e0b; }
.status-dot[data-status="responding"] { background: #10b981; }
.status-dot[data-status="sleeping"]   { background: #9ca3af; }
.status-dot[data-status="idle"]       { background: #d4d4d4; }

.session-name {
  font-size: 12px;
  font-weight: 600;
  color: #18181b;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 10px;
  background: #f5f5f5;
  color: #737373;
  flex-shrink: 0;
  text-transform: capitalize;
}
.session-card[data-activity="tooling"]    .activity-badge { background: #eff6ff; color: #2563eb; }
.session-card[data-activity="user_sent"]  .activity-badge { background: #fffbeb; color: #d97706; }
.session-card[data-activity="responding"] .activity-badge { background: #ecfdf5; color: #059669; }
.session-card[data-activity="sleeping"]   .activity-badge { background: #f9fafb; color: #9ca3af; }

/* Stats grid inside card */
.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
}
.stat-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.stat-label {
  font-size: 10px;
  color: #a0a0a0;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.stat-value {
  font-size: 11px;
  color: #404040;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-weight: 500;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

/* Context bar */
.context-bar-wrap {
  grid-column: 1 / -1;
  margin-top: 2px;
}
.context-bar-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 3px;
}
.context-bar-track {
  width: 100%;
  height: 4px;
  background: #f0f0f0;
  border-radius: 2px;
  overflow: hidden;
}
.context-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: #18181b;
  transition: width 0.6s ease;
}
.context-bar-fill[data-level="mid"]  { background: #f59e0b; }
.context-bar-fill[data-level="high"] { background: #ef4444; }

/* Empty state */
.empty-state {
  text-align: center;
  padding: 32px 20px;
  color: #c0c0c0;
  font-size: 12px;
}
.empty-icon {
  font-size: 24px;
  margin-bottom: 8px;
  opacity: 0.4;
}

/* ===== Capabilities ===== */
.cap-group {
  border-top: 1px solid #f8f8f8;
  padding: 0;
}
.cap-group:first-child { border-top: none; }
.cap-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  cursor: pointer;
  user-select: none;
}
.cap-toggle:hover .cap-title { color: #18181b; }
.cap-title {
  font-size: 11px;
  font-weight: 500;
  color: #525252;
  transition: color 0.15s;
}
.cap-chevron {
  font-size: 10px;
  color: #c0c0c0;
  transition: transform 0.2s;
}
.cap-group[data-open="true"] .cap-chevron { transform: rotate(90deg); }
.cap-content {
  display: none;
  padding: 0 0 8px;
}
.cap-group[data-open="true"] .cap-content { display: block; }

.cap-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 11px;
  color: #525252;
}
.cap-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #d4d4d4;
}
.cap-dot[data-status="connected"] { background: #10b981; }
.cap-dot[data-status="detected"]  { background: #10b981; }
.cap-dot[data-status="missing"]   { background: #ef4444; }
.cap-dot[data-status="yes"]       { background: #10b981; }
.cap-dot[data-status="no"]        { background: #d4d4d4; }

/* ===== Session timestamps ===== */
.session-time {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid #f0f0f0;
}
.session-time-item {
  font-size: 9px;
  color: #a0a0a0;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}

/* ===== Character area ===== */
.character-area {
  width: 100%;
  border-bottom: 1px solid #f0f0f0;
  background: #ffffff;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 0;
  overflow: hidden;
}
.character-area canvas {
  display: block;
  width: 100%;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

/* ===== Dark mode toggle ===== */
.dark-toggle {
  width: 28px; height: 16px;
  border-radius: 8px;
  background: #d4d4d4;
  border: none;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
  transition: background 0.2s;
  padding: 0;
}
.dark-toggle::after {
  content: '';
  position: absolute;
  top: 2px; left: 2px;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
}
.dark-toggle[data-on="true"] {
  background: #3b82f6;
}
.dark-toggle[data-on="true"]::after {
  transform: translateX(12px);
}

/* ===== Dark mode overrides ===== */
body.dark { background: #0d1117; color: #e6edf3; }
body.dark ::-webkit-scrollbar-thumb { background: #30363d; }
body.dark ::-webkit-scrollbar-thumb:hover { background: #484f58; }

body.dark .header { border-bottom-color: #21262d; }
body.dark .header-project { color: #e6edf3; }
body.dark .header-git-item { color: #8b949e; }
body.dark .header-git-sep { color: #30363d; }

body.dark .section { border-bottom-color: #21262d; }
body.dark .section-header { color: #8b949e; }

body.dark .session-card {
  background: #161b22;
  border-color: #30363d;
}
body.dark .session-card:hover {
  border-color: #484f58;
  box-shadow: 0 1px 6px rgba(0,0,0,0.3);
}
/* Active card glow in dark mode */
body.dark .session-card[data-activity="tooling"]    { box-shadow: 0 0 8px rgba(59,130,246,0.15); }
body.dark .session-card[data-activity="responding"] { box-shadow: 0 0 8px rgba(16,185,129,0.15); }
body.dark .session-card[data-activity="user_sent"]  { box-shadow: 0 0 8px rgba(245,158,11,0.15); }

body.dark .session-name { color: #e6edf3; }
body.dark .stat-label { color: #8b949e; }
body.dark .stat-value { color: #c9d1d9; }

body.dark .activity-badge { background: #21262d; color: #8b949e; }
body.dark .session-card[data-activity="tooling"]    .activity-badge { background: #132337; color: #58a6ff; }
body.dark .session-card[data-activity="user_sent"]  .activity-badge { background: #2a1f0a; color: #e3b341; }
body.dark .session-card[data-activity="responding"] .activity-badge { background: #0d2818; color: #3fb950; }
body.dark .session-card[data-activity="sleeping"]   .activity-badge { background: #21262d; color: #8b949e; }

body.dark .context-bar-track { background: #21262d; }
body.dark .context-bar-fill { background: #e6edf3; }

body.dark .session-time { border-top-color: #21262d; }
body.dark .session-time-item { color: #8b949e; }

body.dark .empty-state { color: #484f58; }

body.dark .cap-group { border-top-color: #21262d; }
body.dark .cap-toggle:hover .cap-title { color: #e6edf3; }
body.dark .cap-title { color: #8b949e; }
body.dark .cap-chevron { color: #484f58; }
body.dark .cap-item { color: #8b949e; }
body.dark .cap-dot { background: #484f58; }
body.dark .cap-dot[data-status="connected"] { background: #3fb950; }
body.dark .cap-dot[data-status="detected"]  { background: #3fb950; }
body.dark .cap-dot[data-status="missing"]   { background: #f85149; }
body.dark .cap-dot[data-status="yes"]       { background: #3fb950; }

/* Character area */
body.dark .character-area { background: #0d1117; border-bottom-color: #21262d; }

</style>
</head>
<body>
<div id="root">

  <!-- HEADER — folder left, git right -->
  <div class="header">
    <div class="header-left">
      <span class="header-project" id="pi-workspace"></span>
    </div>
    <div class="header-right" style="display:flex;align-items:center;gap:6px;">
      <span class="header-git-item" id="pi-remote"></span>
      <span class="header-git-sep">&middot;</span>
      <span class="header-git-item" id="pi-branch"></span>
      <span class="header-git-sep">&middot;</span>
      <span class="header-git-item" id="pi-user" style="color:#a0a0a0;"></span>
      <span class="header-git-sep">&middot;</span>
      <button class="dark-toggle" id="dark-toggle" data-on="false" title="Toggle dark mode"></button>
    </div>
  </div>

  <!-- CHARACTER -->
  <div class="character-area" id="character-area">
    <canvas id="char-canvas"></canvas>
  </div>

  <!-- ACTIVE SESSION -->
  <div class="section" id="sessions-section">
    <div class="section-header">Current Session</div>
    <div class="section-body" id="session-list">
      <div class="empty-state" id="empty-msg">
        <div class="empty-icon">&#x25CB;</div>
        No active Claude session
      </div>
    </div>
  </div>

  <!-- CAPABILITIES -->
  <div class="section" id="capabilities-section">
    <div class="section-header">Capabilities</div>
    <div class="section-body" id="cap-body">

      <div class="cap-group" data-open="false">
        <div class="cap-toggle" onclick="toggleCap(this)">
          <span class="cap-title">MCP Servers</span>
          <span class="cap-chevron">&#x25B8;</span>
        </div>
        <div class="cap-content" id="cap-mcp">
          <div class="cap-item">
            <span class="cap-dot" data-status="connected"></span>
            <span>Scanning&hellip;</span>
          </div>
        </div>
      </div>

      <div class="cap-group" data-open="false">
        <div class="cap-toggle" onclick="toggleCap(this)">
          <span class="cap-title">Slash Commands</span>
          <span class="cap-chevron">&#x25B8;</span>
        </div>
        <div class="cap-content" id="cap-commands">
          <div class="cap-item" style="color:#a0a0a0;">Detected from session data</div>
        </div>
      </div>

      <div class="cap-group" data-open="false">
        <div class="cap-toggle" onclick="toggleCap(this)">
          <span class="cap-title">CLAUDE.md</span>
          <span class="cap-chevron">&#x25B8;</span>
        </div>
        <div class="cap-content" id="cap-claudemd">
          <div class="cap-item">
            <span class="cap-dot" id="claudemd-dot" data-status="no"></span>
            <span id="claudemd-label">Not detected</span>
          </div>
        </div>
      </div>

      <div class="cap-group" data-open="false">
        <div class="cap-toggle" onclick="toggleCap(this)">
          <span class="cap-title">CLI Tools</span>
          <span class="cap-chevron">&#x25B8;</span>
        </div>
        <div class="cap-content" id="cap-tools">
          <div class="cap-item" style="color:#a0a0a0;">Detected from environment</div>
        </div>
      </div>

    </div>
  </div>

</div>

<script>
const vscodeApi = acquireVsCodeApi();

// ─── Activity labels ────────────────────────────────────────────────────────
const ACTIVITY_LABELS = {
  idle:       'Idle',
  user_sent:  'Waiting',
  tooling:    'Working',
  responding: 'Responding',
  sleeping:   'Sleeping',
};

const ACTIVE_STATES = new Set(['tooling', 'user_sent', 'responding']);

// ─── Tab name tracking ─────────────────────────────────────────────────────
let currentTabNames = [];

// ─── Formatting helpers ─────────────────────────────────────────────────────
function fmtTokens(n) {
  if (!n || n <= 0) return '\\u2014';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function ctxLevel(pct) {
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'mid';
  return '';
}

function fmtTime(ts) {
  if (!ts) return '\\u2014';
  const d = new Date(ts);
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return h12 + ':' + m + ' ' + ampm;
}

function fmtDuration(startTs) {
  if (!startTs) return '\\u2014';
  const elapsed = Date.now() - startTs;
  const secs = Math.floor(elapsed / 1000);
  if (secs < 60) return secs + 's';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return hrs + 'h ' + remMins + 'm';
}

// ─── Build session card ─────────────────────────────────────────────────────
function buildCard(s) {
  const card = document.createElement('div');
  card.className = 'session-card';
  card.dataset.sessionId = s.sessionId;
  card.dataset.activity = s.activity;

  const label = ACTIVITY_LABELS[s.activity] || s.activity;
  const isActive = ACTIVE_STATES.has(s.activity);
  const model = s.model ? s.model.replace('claude-', '').replace(/-/g, ' ') : '\\u2014';
  const pct = s.contextPct > 0 ? s.contextPct : 0;
  const level = ctxLevel(pct);

  // Resolve display name: prefer VS Code tab name, fall back to chatTitle / projectName
  const displayName = s.chatTitle || s.projectName || s.slug;

  // Humanize entrypoint
  const ENTRYPOINT_LABELS = { 'claude-vscode': 'VS Code', 'cli': 'CLI', 'claude-desktop': 'Desktop' };
  const entryLabel = ENTRYPOINT_LABELS[s.entrypoint] || s.entrypoint || '\\u2014';

  // Capitalize mode
  const modeLabel = s.permissionMode
    ? s.permissionMode.charAt(0).toUpperCase() + s.permissionMode.slice(1)
    : '\\u2014';

  // Capitalize speed
  const speedLabel = s.speed
    ? s.speed.charAt(0).toUpperCase() + s.speed.slice(1)
    : '\\u2014';

  card.innerHTML = \`
    <div class="card-top">
      <span class="status-dot" data-status="\${s.activity}" data-active="\${isActive}"></span>
      <span class="session-name">\${displayName}</span>
      <span class="activity-badge">\${label}</span>
    </div>
    <div class="stats-grid">
      <div class="stat-row">
        <span class="stat-label">Model</span>
        <span class="stat-value">\${model}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Branch</span>
        <span class="stat-value">\${s.gitBranch || '\\u2014'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Client</span>
        <span class="stat-value">\${entryLabel}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Mode</span>
        <span class="stat-value">\${modeLabel}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Speed</span>
        <span class="stat-value">\${speedLabel}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">File</span>
        <span class="stat-value" title="\${s.currentFile || ''}">\${s.currentFile || '\\u2014'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Turns</span>
        <span class="stat-value">\${s.turnCount || '\\u2014'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Tools</span>
        <span class="stat-value">\${s.toolUseCount || '\\u2014'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Tokens In</span>
        <span class="stat-value">\${fmtTokens(s.inputTokens)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Tokens Out</span>
        <span class="stat-value">\${fmtTokens(s.outputTokens)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Cache</span>
        <span class="stat-value">\${fmtTokens(s.cacheTokens)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">&nbsp;</span>
        <span class="stat-value">&nbsp;</span>
      </div>
      <div class="context-bar-wrap">
        <div class="context-bar-label">
          <span class="stat-label">Context</span>
          <span class="stat-value">\${pct > 0 ? pct + '%' : '\\u2014'}</span>
        </div>
        <div class="context-bar-track">
          <div class="context-bar-fill" data-level="\${level}" style="width:\${pct}%"></div>
        </div>
      </div>
    </div>
    <div class="session-time">
      <span class="session-time-item">Started \${fmtTime(s.startedAt)}</span>
      <span class="session-time-item">&middot;</span>
      <span class="session-time-item" data-duration-start="\${s.startedAt}">\${fmtDuration(s.startedAt)}</span>
    </div>
  \`;

  return card;
}

// ─── Render sessions ────────────────────────────────────────────────────────
function renderSessions(sessions) {
  // Pick the single most recently active non-sleeping session
  const candidates = (sessions || [])
    .filter(s => s.activity !== 'sleeping')
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  const focused = candidates.length > 0 ? candidates[0] : null;

  const list = document.getElementById('session-list');

  if (!focused) {
    list.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'empty-state'; d.id = 'empty-msg';
    d.innerHTML = '<div class="empty-icon">&#x25CB;</div>No active Claude session';
    list.appendChild(d);
    return;
  }

  // Render only the focused session
  const card = buildCard(focused);
  list.innerHTML = '';
  list.appendChild(card);
}

// ─── Capabilities toggle ────────────────────────────────────────────────────
function toggleCap(toggle) {
  const group = toggle.parentElement;
  const open = group.dataset.open === 'true';
  group.dataset.open = open ? 'false' : 'true';
}

// ─── Message handling ───────────────────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;

  if (msg.type === 'sessionsUpdate') {
    renderSessions(msg.sessions);
    updateCharacter(msg.sessions);
  }

  if (msg.type === 'projectInfo') {
    const d = msg.data;
    const ws = document.getElementById('pi-workspace');
    const br = document.getElementById('pi-branch');
    const rm = document.getElementById('pi-remote');
    const us = document.getElementById('pi-user');
    if (ws) ws.textContent = d.workspace || '\\u2014';
    if (br) br.textContent = d.gitBranch || '\\u2014';
    if (rm) rm.textContent = d.gitRemote || '\\u2014';
    if (us) us.textContent = d.gitUser || '';
  }

  if (msg.type === 'tabNames') {
    currentTabNames = msg.names || [];
  }

  if (msg.type === 'darkMode') {
    applyDarkMode(msg.value);
  }
});

// ─── Duration ticker — updates elapsed time every 30s ──────────────────────
setInterval(() => {
  const els = document.querySelectorAll('[data-duration-start]');
  els.forEach(el => {
    const start = parseInt(el.dataset.durationStart, 10);
    if (start) el.textContent = fmtDuration(start);
  });
}, 30000);

// ─── Dark mode ─────────────────────────────────────────────────────────────
function applyDarkMode(on) {
  document.body.classList.toggle('dark', on);
  const btn = document.getElementById('dark-toggle');
  if (btn) btn.dataset.on = String(on);
}

document.getElementById('dark-toggle').addEventListener('click', () => {
  const isOn = document.body.classList.toggle('dark');
  document.getElementById('dark-toggle').dataset.on = String(isOn);
  vscodeApi.postMessage({ type: 'setDarkMode', value: isOn });
});

// ─── Pixel Art Character Engine ────────────────────────────────────────────
const PX = 4;
const CHAR_W = 48;
const CHAR_H = 40;

const C = {
  skin:     '#F5C6A0',
  skinDark: '#D4956A',
  hair:     '#4A3728',
  shirt:    '#5B8CDE',
  shirtDk:  '#4070B8',
  pants:    '#3D3D5C',
  desk:     '#8B6F47',
  deskDk:   '#6B5535',
  monitor:  '#2D2D2D',
  screen:   '#1E3A5F',
  screenLt: '#2A5080',
  mug:      '#E8E8E8',
  mugDk:    '#C8C8C8',
  steam:    '#D0D0D0',
  bulbOn:   '#FFE066',
  bulbOff:  '#888888',
  zzz:      '#9CA3AF',
  black:    '#000000',
  white:    '#FFFFFF',
  bubble:   '#F5F5F5',
  bubbleDk: '#21262D',
  textLt:   '#1A1A1A',
  textDk:   '#E6EDF3',
};

function px(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x * PX, y * PX, PX, PX);
}

function pxRect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x * PX, y * PX, w * PX, h * PX);
}

function drawDesk(ctx) {
  pxRect(ctx, 2, 30, 44, 2, C.desk);
  pxRect(ctx, 2, 32, 44, 1, C.deskDk);
  pxRect(ctx, 4, 33, 2, 7, C.desk);
  pxRect(ctx, 42, 33, 2, 7, C.desk);
  pxRect(ctx, 9, 28, 4, 2, C.monitor);
  pxRect(ctx, 7, 27, 8, 1, C.monitor);
  pxRect(ctx, 4, 16, 14, 11, C.monitor);
  pxRect(ctx, 5, 17, 12, 9, C.screen);
  pxRect(ctx, 20, 29, 10, 1, C.monitor);
  pxRect(ctx, 20, 28, 10, 1, '#555555');
}

function drawCharBase(ctx, yOff) {
  const y = yOff;
  pxRect(ctx, 29, 18 + y, 6, 6, C.skin);
  pxRect(ctx, 29, 17 + y, 6, 2, C.hair);
  pxRect(ctx, 28, 18 + y, 1, 3, C.hair);
  px(ctx, 31, 20 + y, C.black);
  pxRect(ctx, 28, 24 + y, 8, 5, C.shirt);
  pxRect(ctx, 28, 24 + y, 1, 5, C.shirtDk);
  pxRect(ctx, 28, 29 + y, 8, 2, C.pants);
}

function drawTypingPose(ctx, frame) {
  drawCharBase(ctx, 0);
  const handY = frame % 2 === 0 ? 28 : 27;
  pxRect(ctx, 26, 26, 2, 2, C.shirt);
  pxRect(ctx, 24, handY, 2, 1, C.skin);
  pxRect(ctx, 36, 26, 2, 2, C.shirt);
  pxRect(ctx, 38, handY, 2, 1, C.skin);
  if (frame % 4 < 2) {
    pxRect(ctx, 6, 19, 10, 1, C.screenLt);
    pxRect(ctx, 6, 22, 8, 1, C.screenLt);
  } else {
    pxRect(ctx, 6, 20, 9, 1, C.screenLt);
    pxRect(ctx, 6, 23, 7, 1, C.screenLt);
  }
}

function drawCoffeePose(ctx, frame) {
  drawCharBase(ctx, 0);
  pxRect(ctx, 26, 26, 2, 3, C.shirt);
  pxRect(ctx, 25, 28, 2, 1, C.skin);
  const mugPositions = [
    { ax: 36, ay: 26, mx: 38, my: 28 },
    { ax: 36, ay: 25, mx: 38, my: 26 },
    { ax: 36, ay: 24, mx: 38, my: 24 },
    { ax: 35, ay: 22, mx: 35, my: 21 },
    { ax: 35, ay: 22, mx: 35, my: 21 },
    { ax: 36, ay: 25, mx: 38, my: 26 },
  ];
  const f = frame % 6;
  const p = mugPositions[f];
  pxRect(ctx, p.ax, p.ay, 2, 2, C.shirt);
  pxRect(ctx, p.mx, p.my, 3, 2, C.mug);
  pxRect(ctx, p.mx, p.my, 3, 1, C.mugDk);
  if (f <= 1 || f === 5) {
    const steamY = p.my - 2 - (frame >> 2) % 3;
    px(ctx, p.mx + 1, steamY, C.steam);
    px(ctx, p.mx + 2, steamY - 1, C.steam);
  }
}

function drawThinkingPose(ctx, frame) {
  drawCharBase(ctx, 0);
  pxRect(ctx, 26, 26, 2, 3, C.shirt);
  pxRect(ctx, 25, 28, 2, 1, C.skin);
  pxRect(ctx, 34, 24, 2, 2, C.shirt);
  pxRect(ctx, 34, 21, 2, 2, C.skin);
  const bulbOn = frame % 6 < 3;
  const bulbColor = bulbOn ? C.bulbOn : C.bulbOff;
  px(ctx, 32, 13, bulbColor);
  px(ctx, 31, 14, bulbColor);
  px(ctx, 32, 14, bulbColor);
  px(ctx, 33, 14, bulbColor);
  px(ctx, 32, 15, C.monitor);
  if (bulbOn) {
    px(ctx, 30, 13, C.bulbOn);
    px(ctx, 34, 13, C.bulbOn);
    px(ctx, 32, 11, C.bulbOn);
  }
}

function drawIdlePose(ctx, frame) {
  const breatheOff = frame % 4 < 2 ? 0 : -1;
  drawCharBase(ctx, breatheOff);
  pxRect(ctx, 26, 26 + breatheOff, 2, 3, C.shirt);
  pxRect(ctx, 25, 28 + breatheOff, 2, 1, C.skin);
  pxRect(ctx, 36, 26 + breatheOff, 2, 3, C.shirt);
  pxRect(ctx, 37, 28 + breatheOff, 2, 1, C.skin);
}

function drawSleepPose(ctx, frame) {
  pxRect(ctx, 29, 22, 6, 6, C.skin);
  pxRect(ctx, 29, 21, 6, 2, C.hair);
  pxRect(ctx, 28, 22, 1, 3, C.hair);
  pxRect(ctx, 31, 24, 2, 1, C.black);
  pxRect(ctx, 28, 28, 8, 3, C.shirt);
  pxRect(ctx, 28, 28, 1, 3, C.shirtDk);
  pxRect(ctx, 26, 28, 2, 2, C.shirt);
  pxRect(ctx, 36, 28, 2, 2, C.shirt);
  const zPos = [
    { x: 36, y: 17 },
    { x: 38, y: 14 },
    { x: 40, y: 11 },
  ];
  const showZ = (frame % 4);
  for (let i = 0; i <= showZ && i < zPos.length; i++) {
    const size = 3 + i;
    ctx.fillStyle = C.zzz;
    ctx.globalAlpha = 1 - (i * 0.25);
    ctx.font = size + 'px monospace';
    ctx.fillText('z', zPos[i].x * PX, zPos[i].y * PX);
    ctx.globalAlpha = 1;
  }
}

function drawSpeechBubble(ctx, text, alpha, canvasLogicalW) {
  if (!text || alpha <= 0) return;
  ctx.globalAlpha = alpha;
  const isDark = document.body.classList.contains('dark');
  const bgColor = isDark ? C.bubbleDk : C.bubble;
  const textColor = isDark ? C.textDk : C.textLt;
  const borderColor = isDark ? '#484F58' : '#D4D4D4';
  ctx.font = '10px monospace';
  const maxChars = 28;
  const display = text.length > maxChars ? text.slice(0, maxChars) + '...' : text;
  const metrics = ctx.measureText(display);
  const textW = metrics.width;
  const padX = 8;
  const bubbleW = textW + padX * 2;
  const bubbleH = 16;
  const bubbleX = (canvasLogicalW * PX - bubbleW) / 2;
  const bubbleY = 4;
  const tailX = canvasLogicalW * PX / 2;
  const r = 4;
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.moveTo(bubbleX + r, bubbleY);
  ctx.lineTo(bubbleX + bubbleW - r, bubbleY);
  ctx.quadraticCurveTo(bubbleX + bubbleW, bubbleY, bubbleX + bubbleW, bubbleY + r);
  ctx.lineTo(bubbleX + bubbleW, bubbleY + bubbleH - r);
  ctx.quadraticCurveTo(bubbleX + bubbleW, bubbleY + bubbleH, bubbleX + bubbleW - r, bubbleY + bubbleH);
  ctx.lineTo(tailX + 4, bubbleY + bubbleH);
  ctx.lineTo(tailX, bubbleY + bubbleH + 5);
  ctx.lineTo(tailX - 4, bubbleY + bubbleH);
  ctx.lineTo(bubbleX + r, bubbleY + bubbleH);
  ctx.quadraticCurveTo(bubbleX, bubbleY + bubbleH, bubbleX, bubbleY + bubbleH - r);
  ctx.lineTo(bubbleX, bubbleY + r);
  ctx.quadraticCurveTo(bubbleX, bubbleY, bubbleX + r, bubbleY);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = textColor;
  ctx.textBaseline = 'middle';
  ctx.fillText(display, bubbleX + padX, bubbleY + bubbleH / 2 + 1);
  ctx.globalAlpha = 1;
}

// ─── Animation State ───────────────────────────────────────────────────────
let currentActivity = 'idle';
let currentAction = '';
let bubbleAlpha = 0;
let bubbleTimer = 0;
let frameIndex = 0;
let lastFrameTime = 0;

const FPS_MAP = {
  tooling:    8,
  responding: 6,
  user_sent:  6,
  idle:       4,
  sleeping:   4,
};

const POSE_MAP = {
  tooling:    drawTypingPose,
  responding: drawThinkingPose,
  user_sent:  drawCoffeePose,
  idle:       drawIdlePose,
  sleeping:   drawSleepPose,
};

const BUBBLE_SHOW_MS = 5000;

function updateCharacter(sessions) {
  const candidates = (sessions || [])
    .filter(s => s.activity !== 'sleeping')
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const focused = candidates.length > 0 ? candidates[0] : null;

  if (focused) {
    if (focused.activity !== currentActivity) {
      currentActivity = focused.activity;
      frameIndex = 0;
    }
    if (focused.lastAction && focused.lastAction !== currentAction) {
      currentAction = focused.lastAction;
      bubbleAlpha = 1;
      bubbleTimer = Date.now();
    }
  } else {
    const sleeping = (sessions || []).find(s => s.activity === 'sleeping');
    if (sleeping) {
      currentActivity = 'sleeping';
    } else {
      currentActivity = 'idle';
    }
    currentAction = '';
    bubbleAlpha = 0;
  }
}

function renderFrame(timestamp) {
  const canvas = document.getElementById('char-canvas');
  if (!canvas) { requestAnimationFrame(renderFrame); return; }
  const ctx = canvas.getContext('2d');
  const container = document.getElementById('character-area');
  if (!container) { requestAnimationFrame(renderFrame); return; }

  const containerW = container.clientWidth;
  const logicalW = Math.floor(containerW / PX);
  const canvasW = logicalW * PX;
  const canvasH = CHAR_H * PX;

  if (canvas.width !== canvasW || canvas.height !== canvasH) {
    canvas.width = canvasW;
    canvas.height = canvasH;
  }

  const targetFps = FPS_MAP[currentActivity] || 4;
  const frameInterval = 1000 / targetFps;
  if (timestamp - lastFrameTime < frameInterval) {
    requestAnimationFrame(renderFrame);
    return;
  }
  lastFrameTime = timestamp;

  const isDark = document.body.classList.contains('dark');
  ctx.fillStyle = isDark ? '#0d1117' : '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  const offsetX = Math.floor((logicalW - CHAR_W) / 2);
  ctx.save();
  ctx.translate(offsetX * PX, 0);

  drawDesk(ctx);
  const drawPose = POSE_MAP[currentActivity] || drawIdlePose;
  drawPose(ctx, frameIndex);

  ctx.restore();

  if (currentActivity !== 'sleeping') {
    if (bubbleAlpha > 0 && Date.now() - bubbleTimer > BUBBLE_SHOW_MS) {
      bubbleAlpha = Math.max(0, bubbleAlpha - 0.05);
    }
    drawSpeechBubble(ctx, currentAction, bubbleAlpha, logicalW);
  }

  frameIndex++;
  requestAnimationFrame(renderFrame);
}

requestAnimationFrame(renderFrame);

// ─── Boot ───────────────────────────────────────────────────────────────────
vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
