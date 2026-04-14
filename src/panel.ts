import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { SessionState, UsageStats } from './sessionManager';

export class Panel implements vscode.WebviewViewProvider {
  private static instance: Panel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private sidebarView: vscode.WebviewView | undefined;
  private sessions: Map<string, SessionState> = new Map();
  private disposables: vscode.Disposable[] = [];
  private context: vscode.ExtensionContext;
  private projectInfoTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalMap = new Map<string, vscode.Terminal>();
  private lastUsage: { today: { outputTokens: number }; week: { outputTokens: number } } | null = null;

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
    const extensionUri = this.context.extensionUri;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'assets')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => this.handleWebviewMessage(msg));

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

    const extensionUri = this.context.extensionUri;
    this.panel = vscode.window.createWebviewPanel(
      'pixelAgent',
      'Claude Sessions',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'assets')],
      }
    );

    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage((msg) => this.handleWebviewMessage(msg));

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.registerListeners();
  }

  private handleWebviewMessage(msg: { type: string; value?: boolean; sessionId?: string }): void {
    if (msg.type === 'ready') {
      this.sendSessions(this.sessions);
      this.sendProjectInfo();
      this.sendDarkMode();
      if (this.lastUsage) {
        this.postMessage({ type: 'usageUpdate', usage: this.lastUsage });
      }
    }
    if (msg.type === 'setDarkMode') {
      this.context.workspaceState.update('darkMode', msg.value);
    }
    if (msg.type === 'openSession' && msg.sessionId) {
      this.focusSession(msg.sessionId);
    }
    if (msg.type === 'newSession') {
      vscode.commands.executeCommand('claude-vscode.editor.open').then(
        () => {},
        () => {
          const terminal = vscode.window.createTerminal('Claude');
          terminal.sendText('claude');
          terminal.show();
        }
      );
    }
  }

  private focusSession(sessionId: string): void {
    // 1. Check terminalMap — if we previously opened a terminal for this session, focus it
    const mapped = this.terminalMap.get(sessionId);
    if (mapped) {
      mapped.show();
      return;
    }

    // 2. Scan open tabs for an existing Claude Code webview editor tab and focus it
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputWebview) {
          const vt = (tab.input as vscode.TabInputWebview).viewType;
          if (vt.includes('claude') || vt.includes('Claude')) {
            vscode.commands.executeCommand('workbench.action.focusEditorGroup').then(() => {}, () => {});
            return;
          }
        }
      }
    }

    // 3. Scan open terminals for one whose name includes the sessionId prefix
    const prefix = sessionId.slice(0, 8);
    const existing = vscode.window.terminals.find(t => t.name.includes(prefix));
    if (existing) {
      existing.show();
      return;
    }

    // 4. Fallback — create a new terminal and resume the session
    const terminal = vscode.window.createTerminal(`Claude: ${prefix}`);
    terminal.sendText(`claude --resume ${sessionId}`);
    terminal.show();
    this.terminalMap.set(sessionId, terminal);
  }

  private registerListeners(): void {
    // Avoid duplicate listeners
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.debouncedSendProjectInfo();
      })
    );

    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        for (const [sessionId, terminal] of this.terminalMap) {
          if (terminal === closed) {
            this.terminalMap.delete(sessionId);
            break;
          }
        }
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

  sendUsage(usage: UsageStats): void {
    this.lastUsage = usage;
    this.postMessage({ type: 'usageUpdate', usage });
  }

  sendEnvData(data: { recentFiles: string[]; mcpServers: string[]; recentSessions: { sessionId: string; title: string; lastSeen: number; activity: string }[] }): void {
    this.postMessage({ type: 'envData', data });
  }

  private debouncedSendProjectInfo(): void {
    if (this.projectInfoTimer !== null) { return; }
    this.projectInfoTimer = setTimeout(() => {
      this.projectInfoTimer = null;
      this.sendProjectInfo();
    }, 300);
  }

  sendProjectInfo(): void {
    const editor = vscode.window.activeTextEditor;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const cwd = workspaceFolder?.uri.fsPath ?? '';

    let gitBranch = '';
    let gitRemote = '';
    let gitUser = '';
    let gitLastCommit = '';
    let uncommittedCount = 0;
    let ahead = 0;
    let behind = 0;

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
      try {
        const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
        uncommittedCount = status ? status.split('\n').length : 0;
      } catch { /* ignore */ }
      try {
        ahead = parseInt(execSync('git rev-list @{u}..HEAD --count', { cwd, encoding: 'utf8' }).trim(), 10) || 0;
      } catch { /* no upstream */ }
      try {
        behind = parseInt(execSync('git rev-list HEAD..@{u} --count', { cwd, encoding: 'utf8' }).trim(), 10) || 0;
      } catch { /* no upstream */ }
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
        uncommittedCount,
        ahead,
        behind,
      },
    });
  }

  dispose(): void {
    if (this.projectInfoTimer !== null) {
      clearTimeout(this.projectInfoTimer);
      this.projectInfoTimer = null;
    }
    this.disposables.forEach(d => d.dispose());
    this.panel?.dispose();
    Panel.instance = undefined;
  }

  private getRobotSpriteUri(webview: vscode.Webview): string {
    const uri = vscode.Uri.joinPath(
      this.context.extensionUri, 'assets', 'Robot Character', 'Sprite sheets', 'Directional sprite sheets', 'Down sprite sheet.png'
    );
    return webview.asWebviewUri(uri).toString();
  }

  private buildHtml(webview: vscode.Webview): string {
    const robotUri = this.getRobotSpriteUri(webview);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
  overflow: hidden;
}
.header-right {
  flex-shrink: 0;
}
.header-project {
  font-size: 12px; font-weight: 600; color: #18181b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-git-item {
  font-size: 10px; color: #737373;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 80px;
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
  padding: 12px 14px 8px;
  margin-bottom: 8px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.session-card:last-child { margin-bottom: 0; }
.session-card:hover {
  border-color: #d0d0d0;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}

/* Activity border accent */
.session-card[data-activity="tooling"]    { border-left: 6px solid #3b82f6; }
.session-card[data-activity="user_sent"]  { border-left: 6px solid #f59e0b; }
.session-card[data-activity="thinking"]   { border-left: 6px solid #8b5cf6; }
.session-card[data-activity="responding"] { border-left: 6px solid #10b981; }
.session-card[data-activity="sleeping"]   { border-left: 6px solid #9ca3af; }
.session-card[data-activity="idle"]       { border-left: 6px solid #d4d4d4; }

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
.status-dot[data-status="thinking"]   { background: #8b5cf6; }
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
.session-card[data-activity="thinking"]   .activity-badge { background: #f5f3ff; color: #7c3aed; }
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
  gap: 6px;
  min-width: 0;
}
.stat-label {
  font-size: 10px;
  color: #a0a0a0;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.stat-value {
  font-size: 11px;
  color: #404040;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-weight: 700;
  min-width: 0;
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
  background: #22c55e;
  transition: width 0.6s ease;
}
.context-bar-fill[data-level="green"]        { background: #22c55e; }
.context-bar-fill[data-level="yellow-green"] { background: #84cc16; }
.context-bar-fill[data-level="yellow"]       { background: #eab308; }
.context-bar-fill[data-level="orange"]       { background: #f59e0b; }
.context-bar-fill[data-level="red"]          { background: #ef4444; }

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

/* ===== Character area (inside card) ===== */
.character-area {
  display: flex;
  align-items: center;
  padding: 4px 0 0;
  margin-top: 6px;
  border-top: 1px solid #f0f0f0;
  gap: 6px;
  box-sizing: border-box;
}
.robot-canvas {
  width: 56px;
  height: 56px;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  flex-shrink: 0;
}
.speech-bubble {
  flex: 1;
  min-width: 0;
  min-height: calc(2 * 1.4em + 12px);
  background: #f5f5f5;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 6px 10px;
  position: relative;
  font-size: 11px;
  line-height: 1.4;
  font-family: var(--vscode-editor-font-family, 'SF Mono', 'Fira Code', 'Consolas', monospace);
}
.speech-bubble::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 0; height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-right: 6px solid #e0e0e0;
}
.speech-bubble::after {
  content: '';
  position: absolute;
  left: -5px;
  top: 50%;
  transform: translateY(-50%);
  width: 0; height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-right: 6px solid #f5f5f5;
}
.speech-bubble-content {
  color: #333;
  display: flex;
  align-items: baseline;
  min-width: 0;
}
.speech-text {
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  white-space: normal;
  min-width: 0;
  line-height: 1.4;
}
.dots {
  display: inline-flex;
  margin-left: 1px;
}
.dots span {
  opacity: 0;
  animation: dotPulse 1.4s infinite;
  font-weight: bold;
}
.dots span:nth-child(1) { animation-delay: 0s; }
.dots span:nth-child(2) { animation-delay: 0.2s; }
.dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dotPulse {
  0%, 80%, 100% { opacity: 0; }
  40% { opacity: 1; }
}

/* ===== Usage meters ===== */
.usage-meter { }
.usage-meter-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 3px;
}

/* ===== YOUR TURN badge (per-card) ===== */
.your-turn-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #f59e0b;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 2px 7px 2px 5px;
  border-radius: 10px;
  flex-shrink: 0;
  animation: yourTurnPulse 1.6s ease-in-out infinite;
}
.your-turn-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #fff;
  opacity: 0.9;
}
@keyframes yourTurnPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.75; transform: scale(0.97); }
}
body.dark .your-turn-badge { background: #d97706; }

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

/* ===== Responsive: narrow sidebar ===== */
@media (max-width: 220px) {
  .header { padding: 6px 10px; gap: 6px; }
  .header-right { display: none !important; }
  .section-header { padding: 8px 12px 6px; }
  .section-body { padding: 0 12px 10px; }
  .session-card { padding: 8px 10px 6px; }
  .stats-grid { grid-template-columns: 1fr; gap: 4px; }
  .stat-label { font-size: 9px; }
  .stat-value { font-size: 10px; }
  .activity-badge { display: none; }
  .session-time { display: none; }
  .character-area { display: none; }
}
@media (max-width: 280px) {
  .header { padding: 6px 12px; gap: 8px; }
  .header-git-item, .header-git-sep { display: none; }
  .section-body { padding: 0 14px 10px; }
  .session-card { padding: 10px 12px 6px; }
  .stats-grid { gap: 4px 10px; }
  .stat-label { font-size: 9px; letter-spacing: 0.02em; }
  .stat-value { font-size: 10px; }
  .speech-bubble { padding: 4px 8px; font-size: 10px; }
}
@media (max-width: 180px) {
  .stats-grid { display: none; }
  .session-name { font-size: 11px; }
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
/* Active card border in dark mode */
body.dark .session-card[data-activity="sleeping"]   { border-left-color: #484f58; }
body.dark .session-card[data-activity="idle"]       { border-left-color: #484f58; }

body.dark .session-name { color: #e6edf3; }
body.dark .stat-label { color: #8b949e; }
body.dark .stat-value { color: #c9d1d9; }

body.dark .activity-badge { background: #21262d; color: #8b949e; }
body.dark .session-card[data-activity="tooling"]    .activity-badge { background: #132337; color: #58a6ff; }
body.dark .session-card[data-activity="user_sent"]  .activity-badge { background: #2a1f0a; color: #e3b341; }
body.dark .session-card[data-activity="thinking"]   .activity-badge { background: #1e1533; color: #a78bfa; }
body.dark .session-card[data-activity="responding"] .activity-badge { background: #0d2818; color: #3fb950; }
body.dark .session-card[data-activity="sleeping"]   .activity-badge { background: #21262d; color: #8b949e; }

body.dark .context-bar-track { background: #21262d; }
body.dark .context-bar-fill { background: #22c55e; }

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
body.dark .character-area { border-top-color: #21262d; }
body.dark .speech-bubble { background: #161b22; border-color: #30363d; }
body.dark .speech-bubble::before { border-right-color: #30363d; }
body.dark .speech-bubble::after { border-right-color: #161b22; }
body.dark .speech-bubble-content { color: #e6edf3; }

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

  <!-- USAGE METERS -->
  <div class="section" id="usage-section">
    <div class="section-header">Usage</div>
    <div class="section-body">
      <div class="usage-meter">
        <div class="usage-meter-label">
          <span class="stat-label">Session</span>
          <span class="stat-value" id="usage-today-value">&mdash;</span>
        </div>
        <div class="context-bar-track">
          <div class="context-bar-fill" id="usage-today-bar" data-level="green" style="width:0%"></div>
        </div>
      </div>
      <div class="usage-meter" style="margin-top:8px;">
        <div class="usage-meter-label">
          <span class="stat-label">This Week</span>
          <span class="stat-value" id="usage-week-value">&mdash;</span>
        </div>
        <div class="context-bar-track">
          <div class="context-bar-fill" id="usage-week-bar" data-level="green" style="width:0%"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- SESSIONS -->
  <div class="section" id="sessions-section">
    <div class="section-header" style="display:flex;justify-content:space-between;align-items:center;">
      Sessions
      <button id="new-session-btn" title="New session" style="background:none;border:1px solid var(--vscode-widget-border, #3c3c3c);border-radius:4px;color:var(--vscode-descriptionForeground, #8b949e);cursor:pointer;font-size:13px;line-height:1;padding:2px 7px;">+</button>
    </div>
    <div class="section-body" id="session-list">
      <div class="empty-state" id="empty-msg">
        <div class="empty-icon">&#x25CB;</div>
        No active Claude session
      </div>
    </div>
  </div>

  <!-- RECENT FILES -->
  <div class="section" id="recent-files-section">
    <div class="section-header">Recent Files</div>
    <div class="section-body" id="recent-files-list">
      <div class="cap-item" style="color:#a0a0a0;">Loading&hellip;</div>
    </div>
  </div>

  <!-- GIT STATUS -->
  <div class="section" id="git-status-section">
    <div class="section-header">Git Status</div>
    <div class="section-body" id="git-status-body">
      <div class="stat-row"><span class="stat-label">Branch</span><span class="stat-value" id="git-branch2">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Changes</span><span class="stat-value" id="git-uncommitted">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Ahead/Behind</span><span class="stat-value" id="git-ahead-behind">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Last Commit</span><span class="stat-value" id="git-last-commit" title="">&mdash;</span></div>
    </div>
  </div>

  <!-- MCP SERVERS -->
  <div class="section" id="mcp-section">
    <div class="section-header">MCP Servers</div>
    <div class="section-body" id="mcp-list">
      <div class="cap-item" style="color:#a0a0a0;">Loading&hellip;</div>
    </div>
  </div>

  <!-- SESSION HISTORY -->
  <div class="section" id="session-history-section">
    <div class="section-header">Session History</div>
    <div class="section-body" id="session-history-list">
      <div class="cap-item" style="color:#a0a0a0;">Loading&hellip;</div>
    </div>
  </div>

</div>

<script>
const vscodeApi = acquireVsCodeApi();

// ─── Activity labels ────────────────────────────────────────────────────────
const ACTIVITY_LABELS = {
  idle:       'Idle',
  thinking:   'Thinking',
  user_sent:  'Waiting',
  tooling:    'Working',
  responding: 'Responding',
  sleeping:   'Sleeping',
};

const ENTRYPOINT_LABELS = { 'claude-vscode': 'VS Code', 'cli': 'CLI', 'claude-desktop': 'Desktop' };

const ACTIVE_STATES = new Set(['tooling', 'user_sent', 'thinking', 'responding']);

// ─── Formatting helpers ─────────────────────────────────────────────────────
function fmtTokens(n) {
  if (!n || n <= 0) return '\\u2014';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function ctxLevel(pct) {
  if (pct >= 70) return 'red';
  if (pct >= 50) return 'orange';
  if (pct >= 30) return 'yellow';
  if (pct >= 20) return 'yellow-green';
  return 'green';
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

function fmtAgo(ts) {
  if (!ts) return '\\u2014';
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

// ─── Build session card ─────────────────────────────────────────────────────
function buildCard(s) {
  const card = document.createElement('div');
  card.className = 'session-card';
  card.dataset.sessionId = s.sessionId;
  card.dataset.activity = s.activity;
  card.style.cursor = 'pointer';
  card.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'openSession', sessionId: s.sessionId });
  });

  const label = ACTIVITY_LABELS[s.activity] || s.activity;
  const isActive = ACTIVE_STATES.has(s.activity);
  const model = s.model ? s.model.replace('claude-', '').replace(/-/g, ' ') : '\\u2014';
  const pct = s.contextPct > 0 ? s.contextPct : 0;
  const level = ctxLevel(pct);

  const displayName = s.chatTitle || s.projectName || s.slug;

  const entryLabel = ENTRYPOINT_LABELS[s.entrypoint] || s.entrypoint || '\\u2014';

  // Map permission mode to friendly label
  const MODE_LABELS = {
    'default': 'Ask Before Edit',
    'plan': 'Plan Mode',
    'auto-edit': 'Auto Edit',
    'full-auto': 'Full Auto',
    'bypassPermissions': 'YOLO',
    'none': 'None',
  };
  const modeLabel = MODE_LABELS[s.permissionMode] || s.permissionMode || '\\u2014';

  card.innerHTML = \`
    <div class="card-top">
      <span class="status-dot" data-status="\${s.activity}" data-active="\${isActive}"></span>
      <span class="session-name">\${displayName}</span>
      \${s.activity === 'idle'
        ? '<span class="your-turn-badge"><span class="your-turn-dot"></span>YOUR TURN</span>'
        : \`<span class="activity-badge">\${label}</span>\`
      }
    </div>
    <div class="stats-grid">
      <div class="stat-row">
        <span class="stat-label">Model</span>
        <span class="stat-value">\${model}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">File</span>
        <span class="stat-value" title="\${s.currentFile || ''}">\${s.currentFile || '\\u2014'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Mode</span>
        <span class="stat-value">\${modeLabel}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Source</span>
        <span class="stat-value">\${entryLabel}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Turns</span>
        <span class="stat-value">\${s.turnCount > 0 ? s.turnCount : '\\u2014'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Tools</span>
        <span class="stat-value">\${s.toolUseCount > 0 ? s.toolUseCount : '\\u2014'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">In</span>
        <span class="stat-value">\${fmtTokens(s.inputTokens)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Out</span>
        <span class="stat-value">\${fmtTokens(s.outputTokens)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Cache</span>
        <span class="stat-value">\${fmtTokens(s.cacheTokens)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Branch</span>
        <span class="stat-value" title="\${s.gitBranch || ''}">\${s.gitBranch || '\\u2014'}</span>
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
    <div class="character-area">
      <canvas class="robot-canvas" data-session-id="\${s.sessionId}" width="48" height="48"></canvas>
      <div class="speech-bubble">
        <div class="speech-bubble-content">
          <span class="speech-text">\${s.lastAction || ACTIVITY_LABELS[s.activity] || 'Idle'}</span><span class="dots"><span>.</span><span>.</span><span>.</span></span>
        </div>
      </div>
    </div>
  \`;

  return card;
}

// ─── Render sessions ────────────────────────────────────────────────────────
function renderSessions(sessions) {
  const list = document.getElementById('session-list');

  // Sort by most recent first
  const sorted = (sessions || [])
    .slice()
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  if (sorted.length === 0) {
    list.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'empty-state'; d.id = 'empty-msg';
    d.innerHTML = '<div class="empty-icon">&#x25CB;</div>No active Claude session';
    list.appendChild(d);
    return;
  }

  // Only show the current (most recent) session
  const current = [sorted[0]];

  list.innerHTML = '';
  for (const s of current) {
    list.appendChild(buildCard(s));
  }

  // Update per-card animations
  updateAllAnimations(current);
}

// ─── Message handling ───────────────────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;

  if (msg.type === 'sessionsUpdate') {
    renderSessions(msg.sessions);
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

    // Git status section
    const gb2 = document.getElementById('git-branch2');
    const gu = document.getElementById('git-uncommitted');
    const gab = document.getElementById('git-ahead-behind');
    const glc = document.getElementById('git-last-commit');
    if (gb2) gb2.textContent = d.gitBranch || '\\u2014';
    if (gu) gu.textContent = d.uncommittedCount > 0 ? d.uncommittedCount + ' uncommitted' : 'Clean';
    if (gab) gab.textContent = '\\u2191' + (d.ahead || 0) + ' \\u2193' + (d.behind || 0);
    if (glc) { glc.textContent = d.gitLastCommit || '\\u2014'; glc.title = d.gitLastCommit || ''; }
  }

  if (msg.type === 'envData') {
    const d = msg.data;

    // Recent files
    const rfList = document.getElementById('recent-files-list');
    if (rfList) {
      if (d.recentFiles && d.recentFiles.length > 0) {
        rfList.innerHTML = d.recentFiles.map(f =>
          '<div class="cap-item"><span class="cap-dot" data-status="detected"></span><span>' + f + '</span></div>'
        ).join('');
      } else {
        rfList.innerHTML = '<div class="cap-item" style="color:#a0a0a0;">No files yet</div>';
      }
    }

    // MCP servers
    const mcpList = document.getElementById('mcp-list');
    if (mcpList) {
      if (d.mcpServers && d.mcpServers.length > 0) {
        mcpList.innerHTML = d.mcpServers.map(s =>
          '<div class="cap-item"><span class="cap-dot" data-status="connected"></span><span>' + s + '</span></div>'
        ).join('');
      } else {
        mcpList.innerHTML = '<div class="cap-item" style="color:#a0a0a0;">None configured</div>';
      }
    }

    // Session history
    const shList = document.getElementById('session-history-list');
    if (shList) {
      if (d.recentSessions && d.recentSessions.length > 0) {
        shList.innerHTML = d.recentSessions.map(s => {
          const ago = fmtAgo(s.lastSeen);
          const dot = ACTIVE_STATES.has(s.activity) ? 'connected' : (s.activity === 'sleeping' ? 'no' : 'detected');
          const title = s.title.length > 28 ? s.title.slice(0, 28) + '\\u2026' : s.title;
          return '<div class="cap-item" style="justify-content:space-between;"><span style="display:flex;align-items:center;gap:6px;min-width:0;"><span class="cap-dot" data-status="' + dot + '"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + title + '</span></span><span style="color:#a0a0a0;font-size:10px;flex-shrink:0;">' + ago + '</span></div>';
        }).join('');
      } else {
        shList.innerHTML = '<div class="cap-item" style="color:#a0a0a0;">No sessions</div>';
      }
    }
  }

  if (msg.type === 'usageUpdate') {
    updateUsageMeters(msg.usage);
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

// ─── Usage meters ──────────────────────────────────────────────────────────
function updateUsageMeters(usage) {
  if (!usage) return;
  const cu = usage.claudeUsage;

  const sessionPct = cu ? cu.sessionPercentage : 0;
  const weekPct    = cu ? cu.weeklyPercentage  : 0;
  const sessionUsed = cu ? cu.sessionTokensUsed : 0;
  const weekUsed    = cu ? cu.weeklyTokensUsed  : 0;
  const weekLimit   = cu ? cu.weeklyLimit       : 0;

  const todayVal = document.getElementById('usage-today-value');
  const weekVal  = document.getElementById('usage-week-value');
  const todayBar = document.getElementById('usage-today-bar');
  const weekBar  = document.getElementById('usage-week-bar');

  if (todayVal) todayVal.textContent = Math.round(sessionPct) + '%';
  if (weekVal)  weekVal.textContent  = Math.round(weekPct) + '% of ' + fmtTokens(weekLimit);
  if (todayBar) {
    todayBar.style.width = Math.min(100, sessionPct) + '%';
    todayBar.dataset.level = ctxLevel(sessionPct);
  }
  if (weekBar) {
    weekBar.style.width = Math.min(100, weekPct) + '%';
    weekBar.dataset.level = ctxLevel(weekPct);
  }
}

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

document.getElementById('new-session-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  vscodeApi.postMessage({ type: 'newSession' });
});

// ─── Robot Sprite Animation ────────────────────────────────────────────────
const ROBOT_URI = '${robotUri}';
const FRAME_W = 48;
const FRAME_H = 48;

// Sprite sheet rows (alphabetical: Crouching 0-10, Standing 11-21)
// Frame counts verified against actual sprite sheet content
const ANIMS = {
  crouchAttack:      { row: 0,  frames: 5 },
  crouchHurt:        { row: 1,  frames: 5 },
  crouchIdle:        { row: 2,  frames: 5 },
  crouchIdleCarry:   { row: 3,  frames: 5 },
  crouchInteract:    { row: 4,  frames: 3 },
  crouchJump:        { row: 5,  frames: 3 },
  crouchLand:        { row: 6,  frames: 5 },
  crouchRun:         { row: 7,  frames: 5 },
  crouchRunCarry:    { row: 8,  frames: 5 },
  crouchWalk:        { row: 9,  frames: 4 },
  crouchWalkCarry:   { row: 10, frames: 4 },
  standAttack:       { row: 11, frames: 5 },
  standHurt:         { row: 12, frames: 5 },
  standIdle:         { row: 13, frames: 5 },
  standIdleCarry:    { row: 14, frames: 5 },
  standInteract:     { row: 15, frames: 3 },
  standJump:         { row: 16, frames: 3 },
  standLand:         { row: 17, frames: 5 },
  standRun:          { row: 18, frames: 5 },
  standRunCarry:     { row: 19, frames: 5 },
  standWalk:         { row: 20, frames: 4 },
  standWalkCarry:    { row: 21, frames: 4 },
};

// Map session state + lastAction to animation
function pickAnim(activity, lastAction) {
  const act = (lastAction || '').toLowerCase();

  // Non-tooling states
  if (activity === 'sleeping')  return 'crouchIdle';
  if (activity === 'thinking')  return 'standIdleCarry';
  if (activity === 'user_sent') return 'standIdleCarry';
  if (activity === 'idle')      return 'standIdle';
  if (activity === 'responding') return 'crouchInteract';

  // Tooling — each tool gets its own animation
  if (activity === 'tooling') {
    // Destructive → electrocution/hurt!
    if (/\\b(rm |delet|remov|clean|drop|destroy|unlink)/.test(act)) return 'standHurt';
    // Edit → standing attack (striking changes)
    if (act.startsWith('editing'))   return 'standAttack';
    // Write → crouching attack (creating new)
    if (act.startsWith('writing'))   return 'crouchAttack';
    // Read → standing interact (inspecting)
    if (act.startsWith('reading'))   return 'standInteract';
    // Bash → standing run (running commands)
    if (act.startsWith('running'))   return 'standRun';
    // Grep → standing walk (searching)
    if (act.startsWith('searching')) return 'standWalk';
    // Glob → crouching walk (finding files low)
    if (act.startsWith('finding'))   return 'crouchWalk';
    // Agent → standing run carrying (delegating)
    if (act.startsWith('delegat') || act.includes('agent')) return 'standRunCarry';
    // TodoWrite → crouching idle carry (organizing)
    if (act.includes('todo'))        return 'crouchIdleCarry';
    // WebSearch → standing jump (leaping to web)
    if (act.includes('web search'))  return 'standJump';
    // WebFetch → crouching jump (fetching from web)
    if (act.includes('fetch'))       return 'crouchJump';
    // Commit/push → crouching run (rushing to commit)
    if (act.includes('commit') || act.includes('push')) return 'crouchRun';
    // Notebook → crouching walk carry
    if (act.includes('notebook'))    return 'crouchWalkCarry';
    // Install/build → crouching run carry (heavy lifting)
    if (act.includes('install') || act.includes('build') || act.includes('npm')) return 'crouchRunCarry';
    // Error/fail → crouching hurt
    if (act.includes('error') || act.includes('fail')) return 'crouchHurt';
    // Landing/done → standing land
    if (act.includes('complet') || act.includes('success')) return 'standLand';
    // Save/download → crouching land
    if (act.includes('save') || act.includes('download') || act.includes('export')) return 'crouchLand';
    // Default tooling → standing walk carry
    return 'standWalkCarry';
  }

  return 'standIdle';
}

// Per-session animation state: sessionId -> { anim, frame }
const _animStates = {};
let _robotImg = null;
let _robotReady = false;
let _lastSpriteTime = 0;
const SPRITE_INTERVAL = 143; // ~7 FPS sprite cycling

// Draw a specific session's robot frame on its canvas
function drawRobotForSession(canvas, sessionId) {
  if (!canvas || !_robotReady || !_robotImg) return;
  const state = _animStates[sessionId] || { anim: 'standIdle', frame: 0 };
  const ctx = canvas.getContext('2d');
  const anim = ANIMS[state.anim] || ANIMS.standIdle;
  const frame = state.frame % anim.frames;
  const sx = frame * FRAME_W;
  const sy = anim.row * FRAME_H;

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, FRAME_W, FRAME_H);
  ctx.drawImage(_robotImg, sx, sy, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
}

// 30 FPS render loop; sprite frames advance at ~7 FPS
function renderLoop(ts) {
  if (_robotReady) {
    const advance = ts - _lastSpriteTime >= SPRITE_INTERVAL;
    if (advance) _lastSpriteTime = ts;

    const canvases = document.querySelectorAll('canvas.robot-canvas[data-session-id]');
    canvases.forEach(canvas => {
      const sid = canvas.dataset.sessionId;
      if (advance && _animStates[sid]) {
        _animStates[sid].frame++;
      }
      drawRobotForSession(canvas, sid);
    });
  }
  requestAnimationFrame(renderLoop);
}

// Load sprite sheet — only start animation AFTER image is ready
(function loadRobotSprite() {
  _robotImg = new Image();
  _robotImg.onload = () => {
    _robotReady = true;
    requestAnimationFrame(renderLoop);
  };
  _robotImg.src = ROBOT_URI;
})();

// Update all per-card animations from session data
function updateAllAnimations(sessions) {
  for (const s of sessions) {
    const newAnim = pickAnim(s.activity, s.lastAction);
    const existing = _animStates[s.sessionId];
    if (!existing || existing.anim !== newAnim) {
      _animStates[s.sessionId] = { anim: newAnim, frame: 0 };
    }
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────
vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
