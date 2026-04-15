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
  private lastUsage: UsageStats | null = null;
  private lastEnvData: unknown = null;
  private onReadyCallback: (() => void) | null = null;

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

  private handleWebviewMessage(msg: { type: string; value?: boolean; sessionId?: string; path?: string; url?: string; file?: string; name?: string }): void {
    if (msg.type === 'ready') {
      this.sendSessions(this.sessions);
      this.sendProjectInfo();
      this.sendDarkMode();
      if (this.lastEnvData) {
        this.postMessage({ type: 'envData', data: this.lastEnvData });
      }
      // Send cached usage immediately so bars don't flash 0%
      if (this.lastUsage) {
        this.postMessage({ type: 'usageUpdate', usage: this.lastUsage });
      }
      // Then trigger fresh fetch on top
      if (this.onReadyCallback) { this.onReadyCallback(); }
    }
    if (msg.type === 'refreshUsage') {
      this.sendSessions(this.sessions);
      this.sendProjectInfo();
      if (this.onReadyCallback) { this.onReadyCallback(); }
    }
    if (msg.type === 'setDarkMode') {
      this.context.workspaceState.update('darkMode', msg.value);
    }
    if (msg.type === 'openUrl' && msg.url) {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
    }
    if (msg.type === 'openFile' && msg.file) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const uri = vscode.Uri.joinPath(workspaceFolder.uri, msg.file);
        vscode.workspace.openTextDocument(uri).then(
          doc => vscode.window.showTextDocument(doc),
          () => {
            // Try finding by basename across workspace
            vscode.workspace.findFiles(`**/${msg.file}`, null, 1).then(files => {
              if (files.length > 0) {
                vscode.workspace.openTextDocument(files[0]).then(
                  doc => vscode.window.showTextDocument(doc),
                  () => {}
                );
              }
            });
          }
        );
      }
    }
    if (msg.type === 'openFolder' && msg.path) {
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
    }
    if (msg.type === 'inputSkill' && msg.name) {
      // Find the active Claude terminal and type the skill command
      const active = vscode.window.activeTerminal;
      if (active) {
        active.sendText(msg.name, false);
        active.show();
      } else {
        // Fallback: copy to clipboard
        vscode.env.clipboard.writeText(msg.name);
        vscode.window.showInformationMessage(`Copied ${msg.name} to clipboard`);
      }
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

  onReady(callback: () => void): void {
    this.onReadyCallback = callback;
  }

  sendUsage(usage: UsageStats): void {
    this.lastUsage = usage;
    this.postMessage({ type: 'usageUpdate', usage });
  }

  sendEnvData(data: { recentFiles: string[]; mcpServers: string[]; recentSessions: { sessionId: string; title: string; lastSeen: number; activity: string }[]; skills: { name: string; source: string; description: string }[] }): void {
    this.lastEnvData = data;
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
    let totalCommits = 0;
    let lastCommitDate = '';
    let contributors = 0;
    let stashCount = 0;
    let branchCount = 0;
    let tagCount = 0;
    let isPrivate: boolean | null = null;
    let stars = 0;
    let forks = 0;
    let openIssues = 0;
    let openPRs = 0;
    let lastPushed = '';
    let repoCreated = '';
    let diskUsage = '';

    const git = (cmd: string): string => {
      try { return execSync(cmd, { cwd, encoding: 'utf8', timeout: 5000 }).trim(); }
      catch { return ''; }
    };

    if (cwd) {
      gitBranch = git('git rev-parse --abbrev-ref HEAD');
      const remote = git('git remote get-url origin');
      if (remote) {
        const match = remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
        gitRemote = match ? match[1] : remote;
      }
      gitUser = git('git config user.name');
      gitLastCommit = git('git log -1 --format=%s');
      lastCommitDate = git('git log -1 --format=%ai');
      const status = git('git status --porcelain');
      uncommittedCount = status ? status.split('\n').length : 0;
      ahead = parseInt(git('git rev-list @{u}..HEAD --count'), 10) || 0;
      behind = parseInt(git('git rev-list HEAD..@{u} --count'), 10) || 0;
      totalCommits = parseInt(git('git rev-list --count HEAD'), 10) || 0;
      const contribOut = git('git shortlog -sn --all');
      contributors = contribOut ? contribOut.split('\n').length : 0;
      const stashOut = git('git stash list');
      stashCount = stashOut ? stashOut.split('\n').length : 0;
      const branchOut = git('git branch -a');
      branchCount = branchOut ? branchOut.split('\n').length : 0;
      tagCount = parseInt(git('git tag -l | wc -l'), 10) || 0;

      // GitHub API data via gh CLI
      const ghJson = git('gh repo view --json isPrivate,stargazerCount,forkCount,pushedAt,createdAt,diskUsage,issues,pullRequests 2>/dev/null');
      if (ghJson) {
        try {
          const gh = JSON.parse(ghJson);
          isPrivate = gh.isPrivate ?? null;
          stars = gh.stargazerCount ?? 0;
          forks = gh.forkCount ?? 0;
          openIssues = gh.issues?.totalCount ?? 0;
          openPRs = gh.pullRequests?.totalCount ?? 0;
          lastPushed = gh.pushedAt ?? '';
          repoCreated = gh.createdAt ?? '';
          if (gh.diskUsage) {
            const kb = gh.diskUsage;
            diskUsage = kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
          }
        } catch { /* ignore parse errors */ }
      }
    }

    this.postMessage({
      type: 'projectInfo',
      data: {
        workspace: workspaceFolder?.name ?? '',
        workspacePath: cwd,
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
        totalCommits,
        lastCommitDate,
        contributors,
        stashCount,
        branchCount,
        tagCount,
        isPrivate,
        stars,
        forks,
        openIssues,
        openPRs,
        lastPushed,
        repoCreated,
        diskUsage,
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
/* ===== CSS Variables ===== */
:root {
  --bg: #0b0e14;
  --bg-card: rgba(22, 27, 34, 0.8);
  --bg-card-hover: rgba(30, 37, 46, 0.9);
  --border: rgba(48, 54, 61, 0.6);
  --border-hover: rgba(80, 90, 100, 0.6);
  --text: #c9d1d9;
  --text-bright: #e6edf3;
  --text-dim: #6e7681;
  --text-muted: #484f58;
  --accent: #22d3ee;
  --accent-dim: rgba(34, 211, 238, 0.15);
  --green: #10b981;
  --blue: #3b82f6;
  --purple: #a78bfa;
  --amber: #f59e0b;
  --red: #ef4444;
  --mono: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}

/* ===== Reset & Base ===== */
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: 100%; height: 100%;
  background: var(--bg);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
/* Subtle noise texture overlay */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  opacity: 0.03;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  pointer-events: none;
  z-index: 0;
}
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(110,118,129,0.4); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(110,118,129,0.6); }

#root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: 0;
}

/* ===== Sticky top ===== */
#sticky-top {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--bg);
  backdrop-filter: blur(12px);
}

/* ===== Header ===== */
.header {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  gap: 12px;
}
.header-left {
  display: flex; align-items: center; gap: 8px;
  min-width: 0;
  overflow: hidden;
}
.header-right {
  flex-shrink: 0;
}
.header-path {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: color 0.2s;
}
.header-path:hover { color: var(--accent); text-decoration: underline; }
.header-project {
  font-size: 13px; font-weight: 700; color: var(--text-bright);
  white-space: nowrap;
  flex-shrink: 0;
  letter-spacing: -0.01em;
}

/* ===== Section chrome ===== */
.section {
  border-bottom: 1px solid var(--border);
  transition: opacity 0.2s;
}
.section-header {
  padding: 12px 14px 8px 12px;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-bright);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  user-select: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  transition: color 0.15s;
}
.section-header:hover { color: var(--accent); }
.section-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--text-bright);
}
.section-chevron {
  font-size: 13px;
  font-weight: 900;
  color: var(--text-bright);
  transition: transform 0.2s, color 0.15s;
  margin-left: auto;
}
.section-header:hover .section-chevron { color: var(--accent); }
.section-pin {
  width: 14px;
  height: 14px;
  cursor: pointer;
  margin-right: 2px;
  flex-shrink: 0;
  color: var(--text-muted);
  transition: color 0.15s, transform 0.15s;
}
.section-pin:hover { color: var(--text-dim); }
.section-pin[data-pinned="true"] { color: var(--text-bright); transform: rotate(-45deg); }

.section[data-pinned="true"] {
  position: sticky;
  z-index: 5;
  background: var(--bg);
}
.section-header[data-open="false"] .section-chevron { transform: rotate(-90deg); }
.section-header[data-open="false"] + .section-body { display: none; }

/* Drag handle hidden — icons replace it */
.section[draggable="true"] .section-header::before {
  display: none;
}
.section.dragging { opacity: 0.3; }
.section.drag-over { border-top: 2px solid var(--accent); }
.section-body {
  padding: 0 14px 14px 12px;
}

/* ===== Active Sessions (hero) ===== */
.session-card {
  position: relative;
  isolation: isolate;
  border: none;
  border-radius: 10px;
  padding: 14px 16px 10px;
  margin-bottom: 8px;
  background: transparent;
  transition: box-shadow 1s ease;
}
.session-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 10px;
  z-index: 0;
  background: transparent;
  opacity: 0;
  transition: opacity 0.5s ease, background 1s ease;
}
.session-card::after {
  content: '';
  position: absolute;
  inset: 2px;
  border-radius: 8px;
  background: var(--bg);
  z-index: 0;
  transition: background 0.3s;
}
.session-card > * { position: relative; z-index: 1; }
.session-card:last-child { margin-bottom: 0; }
.session-card:hover::after { background: var(--bg); }

/* Activity glow — solid gradient ring matching badge colors */
.session-card[data-activity="tooling"]::before    { opacity: 1; background: linear-gradient(135deg, #3b82f6, #6366f1); }
.session-card[data-activity="user_sent"]::before  { opacity: 1; background: linear-gradient(135deg, #f59e0b, #f97316); }
.session-card[data-activity="thinking"]::before   { opacity: 1; background: linear-gradient(135deg, #a78bfa, #8b5cf6); }
.session-card[data-activity="responding"]::before { opacity: 1; background: linear-gradient(135deg, #10b981, #06b6d4); }
.session-card[data-activity="idle"]::before       { opacity: 1; background: linear-gradient(135deg, #f59e0b, #ef4444); }
.session-card[data-activity="sleeping"]::before   { opacity: 1; background: linear-gradient(135deg, #4b5563, #374151); }

/* Outer glow — pulsing */
.session-card[data-activity="tooling"]    { animation: glowTooling 2s ease-in-out infinite; }
.session-card[data-activity="user_sent"]  { animation: glowUserSent 2s ease-in-out infinite; }
.session-card[data-activity="thinking"]   { animation: glowThinking 2s ease-in-out infinite; }
.session-card[data-activity="responding"] { animation: glowResponding 2s ease-in-out infinite; }
.session-card[data-activity="idle"]       { animation: glowIdle 2s ease-in-out infinite; }
.session-card[data-activity="sleeping"]   { animation: glowSleeping 3s ease-in-out infinite; }

@keyframes glowTooling {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 20px -2px rgba(59,130,246,0.3), 0 0 40px -5px rgba(99,102,241,0.15); }
}
@keyframes glowUserSent {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 20px -2px rgba(245,158,11,0.3), 0 0 40px -5px rgba(249,115,22,0.15); }
}
@keyframes glowThinking {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 20px -2px rgba(167,139,250,0.3), 0 0 40px -5px rgba(139,92,246,0.15); }
}
@keyframes glowResponding {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 20px -2px rgba(16,185,129,0.3), 0 0 40px -5px rgba(6,182,212,0.15); }
}
@keyframes glowIdle {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 20px -2px rgba(245,158,11,0.3), 0 0 40px -5px rgba(239,68,68,0.15); }
}
@keyframes glowSleeping {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 20px -2px rgba(75,85,99,0.25), 0 0 40px -5px rgba(55,65,81,0.12); }
}

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
  background: var(--text-muted);
  position: relative;
}
.status-dot::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  background: inherit;
  opacity: 0;
}
@keyframes pulse {
  0%, 100% { opacity: 0; transform: scale(0.8); }
  50% { opacity: 0.5; transform: scale(1.1); }
}
.status-dot[data-active="true"]::after {
  animation: pulse 2s ease-in-out infinite;
}
.status-dot[data-status="tooling"]    { background: var(--blue); }
.status-dot[data-status="user_sent"]  { background: var(--amber); }
.status-dot[data-status="thinking"]   { background: var(--purple); }
.status-dot[data-status="responding"] { background: var(--green); }
.status-dot[data-status="sleeping"]   { background: var(--text-muted); }
.status-dot[data-status="idle"]       { background: var(--text-muted); }

.session-name {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-bright);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.01em;
}

.activity-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 9px;
  font-weight: 700;
  padding: 2px 8px 2px 6px;
  border-radius: 10px;
  background: rgba(255,255,255,0.06);
  color: #fff;
  flex-shrink: 0;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.activity-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #fff;
  opacity: 0.9;
}
.session-card[data-activity="tooling"]    .activity-badge { --pulse-rgb: 59,130,246; background: linear-gradient(135deg, #3b82f6, #6366f1); animation: badgePulse 1.6s ease-in-out infinite; }
.session-card[data-activity="user_sent"]  .activity-badge { --pulse-rgb: 245,158,11; background: linear-gradient(135deg, #f59e0b, #f97316); animation: badgePulse 1.6s ease-in-out infinite; }
.session-card[data-activity="thinking"]   .activity-badge { --pulse-rgb: 167,139,250; background: linear-gradient(135deg, #a78bfa, #8b5cf6); animation: badgePulse 1.6s ease-in-out infinite; }
.session-card[data-activity="responding"] .activity-badge { --pulse-rgb: 16,185,129; background: linear-gradient(135deg, #10b981, #06b6d4); animation: badgePulse 1.6s ease-in-out infinite; }
.session-card[data-activity="sleeping"]   .activity-badge { background: linear-gradient(135deg, #4b5563, #374151); box-shadow: 0 0 6px rgba(75,85,99,0.2); color: #9ca3af; }
.session-card[data-activity="sleeping"]   .activity-dot { opacity: 0.4; }

@keyframes badgePulse {
  0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 10px rgba(var(--pulse-rgb),0.35); }
  50% { opacity: 0.85; transform: scale(0.97); box-shadow: 0 0 16px rgba(var(--pulse-rgb),0.5); }
}

/* Stats grid inside card */
.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px 16px;
}
.stat-row {
  display: flex;
  justify-content: flex-start;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.stat-row::after {
  content: '';
  order: 1;
  flex: 1;
  border-bottom: 1px dotted var(--text-muted);
  margin: 0 4px;
  min-width: 8px;
  position: relative;
  top: -3px;
}
.stat-row .stat-label { order: 0; }
.stat-row .stat-value { order: 2; }
.stat-label {
  font-size: 9px;
  color: var(--text-dim);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}

/* Git status rows extra padding */
#git-status-body .stat-row {
  padding: 3px 0;
}
.stat-value {
  font-size: 11px;
  color: var(--text);
  font-family: var(--mono);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.stat-dim {
  color: var(--text-muted);
  font-weight: 400;
  font-size: 10px;
}

/* Context bar */
.context-bar-wrap {
  grid-column: 1 / -1;
  margin-top: 4px;
}
.context-bar-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 3px;
}
.context-bar-track {
  width: 100%;
  height: 5px;
  background: rgba(255,255,255,0.1);
  border-radius: 2px;
  overflow: hidden;
}
body:not(.dark) .context-bar-track { background: #e5e7eb; }
.context-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.6s ease;
}
.context-bar-fill[data-level="green"]        { background: linear-gradient(90deg, #059669, #22c55e); }
.context-bar-fill[data-level="yellow-green"] { background: linear-gradient(90deg, #22c55e, #84cc16); }
.context-bar-fill[data-level="yellow"]       { background: linear-gradient(90deg, #84cc16, #eab308); }
.context-bar-fill[data-level="orange"]       { background: linear-gradient(90deg, #eab308, #f59e0b); }
.context-bar-fill[data-level="red"]          { background: linear-gradient(90deg, #f59e0b, #ef4444); }

/* Time marker on usage bars */
.time-marker {
  position: absolute;
  top: 0;
  width: 2px;
  height: 100%;
  background: #e6edf3;
  border-radius: 1px;
  transition: left 1s ease;
  z-index: 2;
}
.time-marker-trail {
  position: absolute;
  top: 0;
  width: 24px;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.5));
  border-radius: 1px;
  transition: left 1s ease;
  z-index: 1;
}
body:not(.dark) .time-marker { background: #111827; }
body:not(.dark) .time-marker-trail { background: linear-gradient(90deg, transparent, rgba(0,0,0,0.4)); }


/* Empty state */
.empty-state {
  text-align: center;
  padding: 32px 20px;
  color: var(--text-muted);
  font-size: 12px;
}
.empty-icon {
  font-size: 24px;
  margin-bottom: 8px;
  opacity: 0.3;
}

/* ===== Capabilities ===== */
.link {
  color: var(--accent);
  cursor: pointer;
  text-decoration: none;
  transition: opacity 0.15s;
}
.link:hover { opacity: 0.8; text-decoration: underline; }

.cap-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 11px;
  color: var(--text);
}
.cap-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-muted);
}
.cap-dot[data-status="connected"] { background: var(--green); box-shadow: 0 0 4px rgba(16,185,129,0.5); }
.cap-dot[data-status="detected"]  { background: var(--green); box-shadow: 0 0 4px rgba(16,185,129,0.5); }
.cap-dot[data-status="missing"]   { background: var(--red); box-shadow: 0 0 4px rgba(239,68,68,0.5); }
.cap-dot[data-status="yes"]       { background: var(--green); box-shadow: 0 0 4px rgba(16,185,129,0.5); }
.cap-dot[data-status="no"]        { background: var(--text-muted); }

/* ===== Session timestamps ===== */
.session-time {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.card-refresh-btn {
  margin-left: auto;
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 2px 6px;
  transition: color 0.15s, border-color 0.15s;
}
.card-refresh-btn:hover { color: var(--accent); border-color: var(--accent); }
.extra-usage-badge {
  display: inline-block;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  border-radius: 4px;
  background: linear-gradient(135deg, #ff6b35, #ff4444);
  color: #fff;
  text-transform: uppercase;
  animation: extra-pulse 2s ease-in-out infinite;
  white-space: nowrap;
  vertical-align: middle;
}
@keyframes extra-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 4px rgba(255,68,68,0.4); }
  50% { opacity: 0.85; box-shadow: 0 0 8px rgba(255,107,53,0.6); }
}
.session-time-item {
  font-size: 9px;
  color: var(--text-dim);
  font-family: var(--mono);
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

/* ===== Skills filter & items ===== */
.skills-filter-btn {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-family: inherit;
  font-weight: 500;
  transition: all 0.15s;
}
.skills-filter-btn:hover { border-color: var(--accent); color: var(--accent); }
.skills-filter-btn[data-active="true"] {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
  font-weight: 700;
}
#skills-search {
  background: rgba(255,255,255,0.04);
  border-color: var(--border);
  color: var(--text);
}
#skills-search:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim); }
.skill-item {
  padding: 5px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  cursor: pointer;
}
.skill-item:hover { opacity: 0.8; }
.skill-item:last-child { border-bottom: none; }
.skill-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-bright);
}
.skill-desc {
  font-size: 10px;
  color: var(--text-dim);
  line-height: 1.3;
  margin-top: 1px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.skill-badge {
  font-size: 8px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 4px;
  letter-spacing: 0.04em;
}
.skill-badge-user { background: rgba(34,211,238,0.12); color: var(--accent); }
.skill-badge-plugin { background: rgba(255,255,255,0.06); color: var(--text-dim); }

/* ===== Usage meters ===== */
.usage-card {
  background: var(--bg);
  border: 2px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px 6px;
}
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
  background: linear-gradient(135deg, #f59e0b, #ef4444);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 2px 8px 2px 6px;
  border-radius: 10px;
  flex-shrink: 0;
  animation: yourTurnPulse 1.6s ease-in-out infinite;
  box-shadow: 0 0 10px rgba(245,158,11,0.3);
}
.your-turn-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #fff;
  opacity: 0.9;
}
@keyframes yourTurnPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.8; transform: scale(0.97); }
}

/* ===== Dark mode toggle ===== */
.dark-toggle {
  width: 32px; height: 18px;
  border-radius: 9px;
  background: rgba(255,255,255,0.1);
  border: 1px solid var(--border);
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
  transition: background 0.3s, border-color 0.3s;
  padding: 0;
}
.dark-toggle::after {
  content: '';
  position: absolute;
  top: 2px; left: 2px;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: var(--text-bright);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: none;
}
.dark-toggle[data-on="true"]::after {
  transform: translateX(14px);
}
.dark-toggle:hover { border-color: var(--text-bright); }
.toggle-sun { color: var(--amber); }
.toggle-moon { color: var(--text-muted); }
.dark-toggle[data-on="true"] .toggle-sun { color: var(--text-muted); }
.dark-toggle[data-on="true"] .toggle-moon { color: var(--amber); }

/* ===== Responsive: narrow sidebar ===== */
@media (max-width: 220px) {
  .header { padding: 6px 10px; gap: 6px; }
  .header-right { display: none !important; }
  .section-header { padding: 8px 12px 6px; }
  .section-body { padding: 0 12px 10px; }
  .session-card { padding: 10px 12px 8px; }
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
  .session-card { padding: 12px 14px 8px; }
  .stats-grid { gap: 4px 10px; }
  .stat-label { font-size: 9px; letter-spacing: 0.02em; }
  .stat-value { font-size: 10px; }
  .speech-bubble { padding: 4px 8px; font-size: 10px; }
}
@media (max-width: 180px) {
  .stats-grid { display: none; }
  .session-name { font-size: 11px; }
}

/* ===== Light mode overrides (dark is default) ===== */
body:not(.dark) {
  --bg: #f8f9fa;
  --bg-card: rgba(255,255,255,0.9);
  --bg-card-hover: rgba(255,255,255,1);
  --border: rgba(0,0,0,0.08);
  --border-hover: rgba(0,0,0,0.15);
  --text: #374151;
  --text-bright: #111827;
  --text-dim: #6b7280;
  --text-muted: #9ca3af;
  --accent: #0891b2;
  --accent-dim: rgba(8,145,178,0.1);
}
body:not(.dark)::before { opacity: 0.015; }

/* Robot status bar (sticky header row 2) */
.robot-bar {
  display: flex;
  align-items: center;
  padding: 3px 6px 5px 11px;
  gap: 0;
  border-bottom: 1px solid var(--border);
  background: rgba(255,255,255,0.02);
}
.robot-bar-canvas {
  width: 28px;
  height: 28px;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  flex-shrink: 0;
  filter: drop-shadow(0 0 3px rgba(34,211,238,0.2));
}
.robot-bar-bubble {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-dim);
  display: flex;
  align-items: baseline;
}
.robot-bar-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}
.robot-bar-text .action-target {
  color: var(--text-bright);
  font-weight: 700;
}

</style>
</head>
<body>
<div id="root">

  <!-- STICKY TOP -->
  <div id="sticky-top">
    <!-- HEADER -->
    <div class="header">
      <div class="header-left">
        <span class="header-project" id="pi-workspace"></span>
        <span class="header-path" id="pi-path" onclick="if(this.dataset.path)vscodeApi.postMessage({type:'openFolder',path:this.dataset.path})"></span>
      </div>
      <div class="header-right" style="display:flex;align-items:center;gap:6px;">
        <button class="dark-toggle" id="dark-toggle" data-on="false" title="Toggle dark mode">
          <svg class="toggle-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px;position:absolute;left:3px;top:3px;"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <svg class="toggle-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px;position:absolute;right:3px;top:3px;"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
      </div>
    </div>
    <!-- ROBOT STATUS BAR -->
    <div class="robot-bar">
      <canvas class="robot-bar-canvas" id="robot-bar-canvas" width="48" height="48"></canvas>
      <div class="robot-bar-bubble" id="robot-bar-bubble">
        <span class="robot-bar-text" id="robot-bar-text">Idle</span><span class="dots"><span>.</span><span>.</span><span>.</span></span>
      </div>
    </div>

  </div><!-- /sticky-top -->

  <!-- SESSIONS -->
  <div class="section" id="sessions-section" draggable="true">
    <div class="section-header" data-open="true" onclick="toggleSection(this)">
      <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Sessions
      <svg class="section-pin" data-pinned="false" onclick="event.stopPropagation();togglePin(this)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg><span class="section-chevron">&#x25BE;</span>
    </div>
    <div class="section-body" id="session-list">
      <div class="empty-state" id="empty-msg">
        <div class="empty-icon">&#x25CB;</div>
        No active Claude session
      </div>
    </div>
  </div>

  <!-- USAGE METERS -->
  <div class="section" id="usage-section" draggable="true">
    <div class="section-header" data-open="true" onclick="toggleSection(this)">
      <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="18" y="3" width="4" height="18"/><rect x="10" y="8" width="4" height="13"/><rect x="2" y="13" width="4" height="8"/></svg>Usage <svg class="section-pin" data-pinned="false" onclick="event.stopPropagation();togglePin(this)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg><span class="section-chevron">&#x25BE;</span>
    </div>
    <div class="section-body">
      <div class="usage-card">
        <div class="usage-meter">
          <div class="usage-meter-label">
            <span class="stat-label">Session</span>
            <span class="stat-value" id="usage-today-value">&mdash;</span>
          </div>
          <div class="context-bar-track" style="position:relative;overflow:visible;">
            <div class="context-bar-fill" id="usage-today-bar" data-level="green" style="width:0%"></div>
            <div class="time-marker-trail" id="usage-today-trail"></div>
            <div class="time-marker" id="usage-today-marker"></div>
          </div>
        </div>
        <div class="usage-meter" style="margin-top:8px;">
          <div class="usage-meter-label">
            <span class="stat-label">This Week</span>
            <span class="stat-value" id="usage-week-value">&mdash;</span>
          </div>
          <div class="context-bar-track" style="position:relative;overflow:visible;">
            <div class="context-bar-fill" id="usage-week-bar" data-level="green" style="width:0%"></div>
            <div class="time-marker-trail" id="usage-week-trail"></div>
            <div class="time-marker" id="usage-week-marker"></div>
          </div>
        </div>
        <div class="session-time">
          <span class="stat-value" id="usage-plan-label" style="font-size:10px;">&mdash;</span>
          <button class="card-refresh-btn" title="Refresh all" onclick="event.stopPropagation();refreshUsage();">&#x21bb;</button>
        </div>
      </div>
    </div>
  </div>

  <!-- GIT STATUS -->
  <div class="section" id="git-status-section" draggable="true">
    <div class="section-header" data-open="true" onclick="toggleSection(this)"><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>Git Status <svg class="section-pin" data-pinned="false" onclick="event.stopPropagation();togglePin(this)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg><span class="section-chevron">&#x25BE;</span></div>
    <div class="section-body" id="git-status-body">
      <div class="stat-row"><span class="stat-label">Repo</span><span class="stat-value" id="git-repo">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Visibility</span><span class="stat-value" id="git-visibility">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Branch</span><span class="stat-value" id="git-branch2">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Branches</span><span class="stat-value" id="git-branch-count">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Changes</span><span class="stat-value" id="git-uncommitted">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Ahead/Behind</span><span class="stat-value" id="git-ahead-behind">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Commits</span><span class="stat-value" id="git-total-commits">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Contributors</span><span class="stat-value" id="git-contributors">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Last Commit</span><span class="stat-value" id="git-last-commit" title="">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Committed</span><span class="stat-value" id="git-last-commit-date">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Last Push</span><span class="stat-value" id="git-last-pushed">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Created</span><span class="stat-value" id="git-created">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Stars</span><span class="stat-value" id="git-stars">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Forks</span><span class="stat-value" id="git-forks">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Issues</span><span class="stat-value" id="git-issues">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">PRs</span><span class="stat-value" id="git-prs">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Tags</span><span class="stat-value" id="git-tags">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Stashes</span><span class="stat-value" id="git-stashes">&mdash;</span></div>
      <div class="stat-row"><span class="stat-label">Size</span><span class="stat-value" id="git-size">&mdash;</span></div>
    </div>
  </div>

  <!-- RECENT FILES -->
  <div class="section" id="recent-files-section" draggable="true">
    <div class="section-header" data-open="true" onclick="toggleSection(this)"><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Recent Files <svg class="section-pin" data-pinned="false" onclick="event.stopPropagation();togglePin(this)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg><span class="section-chevron">&#x25BE;</span></div>
    <div class="section-body" id="recent-files-list">
      <div class="cap-item" style="color:#a0a0a0;">Loading&hellip;</div>
    </div>
  </div>

  <!-- SESSION HISTORY -->
  <div class="section" id="session-history-section" draggable="true">
    <div class="section-header" data-open="true" onclick="toggleSection(this)"><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Session History <svg class="section-pin" data-pinned="false" onclick="event.stopPropagation();togglePin(this)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg><span class="section-chevron">&#x25BE;</span></div>
    <div class="section-body" id="session-history-list">
      <div class="cap-item" style="color:#a0a0a0;">Loading&hellip;</div>
    </div>
  </div>

  <!-- MCP SERVERS -->
  <div class="section" id="mcp-section" draggable="true">
    <div class="section-header" data-open="true" onclick="toggleSection(this)"><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>MCP Servers <svg class="section-pin" data-pinned="false" onclick="event.stopPropagation();togglePin(this)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg><span class="section-chevron">&#x25BE;</span></div>
    <div class="section-body" id="mcp-list">
      <div class="cap-item" style="color:#a0a0a0;">Loading&hellip;</div>
    </div>
  </div>

  <!-- SKILLS -->
  <div class="section" id="skills-section" draggable="true">
    <div class="section-header" data-open="true" onclick="toggleSection(this)"><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Skills <svg class="section-pin" data-pinned="false" onclick="event.stopPropagation();togglePin(this)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg><span class="section-chevron">&#x25BE;</span></div>
    <div class="section-body">
      <input type="text" id="skills-search" placeholder="Search skills..." style="width:100%;padding:4px 8px;margin-bottom:6px;font-size:11px;border:1px solid #e0e0e0;border-radius:4px;background:#fafafa;color:#333;font-family:inherit;outline:none;">
      <div id="skills-filter" style="display:flex;gap:4px;margin-bottom:8px;">
        <button class="skills-filter-btn" data-filter="all" data-active="true">All</button>
        <button class="skills-filter-btn" data-filter="user" data-active="false">User</button>
        <button class="skills-filter-btn" data-filter="plugin" data-active="false">Plugin</button>
      </div>
      <div id="skills-list">
        <div class="cap-item" style="color:#a0a0a0;">Loading&hellip;</div>
      </div>
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
  const totalSecs = Math.floor(elapsed / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hrs > 0) return hrs + 'h ' + mins.toString().padStart(2, '0') + 'm ' + secs.toString().padStart(2, '0') + 's';
  if (mins > 0) return mins + 'm ' + secs.toString().padStart(2, '0') + 's';
  return secs + 's';
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
  const model = s.model ? s.model.replace('claude-', '').replace(/-(\\d+)-(\\d+).*/, ' $1.$2').replace(/(\\w)/, c => c.toUpperCase()) : '\\u2014';
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
        : \`<span class="activity-badge"><span class="activity-dot"></span>\${label}</span>\`
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
        <span class="stat-value">\${fmtTokens(s.lastInputTokens)}<span class="stat-dim"> / \${fmtTokens(s.inputTokens)}</span></span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Out</span>
        <span class="stat-value">\${fmtTokens(s.lastOutputTokens)}<span class="stat-dim"> / \${fmtTokens(s.outputTokens)}</span></span>
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
      <button class="card-refresh-btn" title="New session" onclick="event.stopPropagation();vscodeApi.postMessage({type:'newSession'});">+</button>
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

  // Re-apply cached usage data to the newly built card
  if (_lastUsage) updateUsageMeters(_lastUsage);

  // Update per-card animations
  updateAllAnimations(current);

  // Update robot status bar
  if (sorted.length > 0) {
    const s = sorted[0];
    const txt = document.getElementById('robot-bar-text');
    const isWorking = ACTIVE_STATES.has(s.activity);
    if (txt) {
      const showAction = isWorking && s.activity !== 'thinking' && s.lastAction;
      const raw = showAction ? s.lastAction : (ACTIVITY_LABELS[s.activity] || 'Idle');
      const spaceIdx = raw.indexOf(' ');
      if (spaceIdx > 0 && isWorking) {
        const verb = raw.slice(0, spaceIdx);
        const target = raw.slice(spaceIdx + 1);
        txt.innerHTML = verb + ' <span class="action-target">' + target.replace(/</g, '&lt;') + '</span>';
      } else {
        txt.textContent = raw;
      }
    }
    // Drive robot bar animation
    const newAnim = pickAnim(s.activity, s.lastAction);
    if (!_animStates['__bar'] || _animStates['__bar'].anim !== newAnim) {
      _animStates['__bar'] = { anim: newAnim, frame: 0 };
    }
  }
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
    const pp = document.getElementById('pi-path');
    if (ws) ws.textContent = d.workspace || '\\u2014';
    if (pp) {
      pp.textContent = d.workspacePath || '';
      pp.title = d.workspacePath || '';
      pp.dataset.path = d.workspacePath || '';
    }

    // Git status section
    const gr = document.getElementById('git-repo');
    if (gr) {
      if (d.gitRemote) {
        gr.innerHTML = '<a class="link" onclick="vscodeApi.postMessage({type:\\'openUrl\\',url:\\'https://github.com/' + d.gitRemote + '\\'})">' + d.gitRemote + '</a>';
      } else {
        gr.textContent = '\\u2014';
      }
    }
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const fmtDate = (iso) => {
      if (!iso) return '\\u2014';
      const dt = new Date(iso);
      return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    };

    setEl('git-branch2', d.gitBranch || '\\u2014');
    setEl('git-uncommitted', d.uncommittedCount > 0 ? d.uncommittedCount + ' uncommitted' : 'Clean');
    setEl('git-ahead-behind', '\\u2191' + (d.ahead || 0) + ' \\u2193' + (d.behind || 0));
    const glc = document.getElementById('git-last-commit');
    if (glc) { glc.textContent = d.gitLastCommit || '\\u2014'; glc.title = d.gitLastCommit || ''; }
    setEl('git-last-commit-date', fmtDate(d.lastCommitDate));
    setEl('git-total-commits', d.totalCommits > 0 ? String(d.totalCommits) : '\\u2014');
    setEl('git-contributors', d.contributors > 0 ? String(d.contributors) : '\\u2014');
    setEl('git-branch-count', d.branchCount > 0 ? String(d.branchCount) : '\\u2014');
    setEl('git-tags', d.tagCount > 0 ? String(d.tagCount) : '0');
    setEl('git-stashes', d.stashCount > 0 ? String(d.stashCount) : '0');

    // GitHub API fields
    setEl('git-visibility', d.isPrivate === true ? 'Private' : d.isPrivate === false ? 'Public' : '\\u2014');
    setEl('git-stars', d.stars != null ? String(d.stars) : '\\u2014');
    setEl('git-forks', d.forks != null ? String(d.forks) : '\\u2014');
    setEl('git-issues', d.openIssues != null ? String(d.openIssues) : '\\u2014');
    setEl('git-prs', d.openPRs != null ? String(d.openPRs) : '\\u2014');
    setEl('git-last-pushed', fmtDate(d.lastPushed));
    setEl('git-created', fmtDate(d.repoCreated));
    setEl('git-size', d.diskUsage || '\\u2014');
  }

  if (msg.type === 'envData') {
    const d = msg.data;

    // Recent files
    const rfList = document.getElementById('recent-files-list');
    if (rfList) {
      if (d.recentFiles && d.recentFiles.length > 0) {
        rfList.innerHTML = d.recentFiles.map(f =>
          '<div class="cap-item"><span class="cap-dot" data-status="detected"></span><a class="link" onclick="vscodeApi.postMessage({type:\\'openFile\\',file:\\'' + f + '\\'})">' + f + '</a></div>'
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

    // Skills
    _allSkills = d.skills || [];
    renderSkills();

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

// ─── Duration ticker — updates elapsed time every 1s ───────────────────────
setInterval(() => {
  const els = document.querySelectorAll('[data-duration-start]');
  els.forEach(el => {
    const start = parseInt(el.dataset.durationStart, 10);
    if (start) el.textContent = fmtDuration(start);
  });
}, 1000);

// ─── Usage refresh ─────────────────────────────────────────────────────────
function refreshUsage() {
  // Reset bars and markers to 0, force reflow, then fetch — gives the "fill up" animation
  const sessBar = document.getElementById('usage-today-bar');
  const weekBar = document.getElementById('usage-week-bar');
  const sessMarker = document.getElementById('usage-today-marker');
  const sessTrail  = document.getElementById('usage-today-trail');
  const weekMarker = document.getElementById('usage-week-marker');
  const weekTrail  = document.getElementById('usage-week-trail');

  // Disable transitions, snap to 0
  [sessBar, weekBar].forEach(el => { if (el) { el.style.transition = 'none'; el.style.width = '0%'; } });
  [sessMarker, weekMarker].forEach(el => { if (el) { el.style.transition = 'none'; el.style.left = '0%'; } });
  [sessTrail, weekTrail].forEach(el => { if (el) { el.style.transition = 'none'; el.style.left = '0px'; } });

  // Force reflow so the browser registers 0% before we re-enable transitions
  if (sessBar) sessBar.offsetWidth;

  // Re-enable transitions
  requestAnimationFrame(() => {
    [sessBar, weekBar].forEach(el => { if (el) el.style.transition = ''; });
    [sessMarker, weekMarker, sessTrail, weekTrail].forEach(el => { if (el) el.style.transition = ''; });
    vscodeApi.postMessage({ type: 'refreshUsage' });
  });
}

// ─── Usage meters ──────────────────────────────────────────────────────────
function fmtResetIn(ms) {
  if (ms <= 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return 'resets in ' + mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return 'resets in ' + hrs + 'h ' + (mins % 60) + 'm';
  return 'resets in ' + Math.floor(hrs / 24) + 'd';
}

// Store usage data for time marker animation
let _lastUsage = null;

function updateUsageMeters(usage) {
  if (!usage) return;
  _lastUsage = usage;
  _lastUsageTime = Date.now();

  const sessPct = Math.round(usage.sessionPct);
  const weekPct = Math.round(usage.weeklyPct);

  const sessReset = fmtResetIn(usage.sessionResetMs);
  const weekReset = fmtResetIn(usage.weeklyResetMs);

  const sessVal = document.getElementById('usage-today-value');
  const weekVal = document.getElementById('usage-week-value');

  const planEl = document.getElementById('usage-plan-label');

  const isExtra = !!(usage.overageInUse) || sessPct >= 100 || weekPct >= 100;

  if (usage.live) {
    if (sessVal) sessVal.innerHTML = (sessReset ? '<span style="color:var(--text-muted);font-weight:400;font-size:9px;">' + sessReset + '</span> ' : '') + sessPct + '%';
    if (weekVal) weekVal.innerHTML = (weekReset ? '<span style="color:var(--text-muted);font-weight:400;font-size:9px;">' + weekReset + '</span> ' : '') + weekPct + '%';
    if (planEl) {
      var label = usage.planTier ? 'Claude ' + usage.planTier : '';
      planEl.innerHTML = isExtra
        ? label + ' <span class="extra-usage-badge">EXTRA USAGE</span>'
        : label;
    }
  } else {
    if (sessVal) sessVal.textContent = 'No credentials found';
    if (weekVal) weekVal.textContent = '';
    if (planEl) planEl.innerHTML = '';
  }

  const sessBar = document.getElementById('usage-today-bar');
  const weekBar = document.getElementById('usage-week-bar');
  if (sessBar) { sessBar.style.width = Math.min(100, sessPct) + '%'; sessBar.dataset.level = ctxLevel(sessPct); }
  if (weekBar) { weekBar.style.width = Math.min(100, weekPct) + '%'; weekBar.dataset.level = ctxLevel(weekPct); }

  updateTimeMarkers(usage);
}

let _lastUsageTime = Date.now();

function updateTimeMarkers(usage) {
  if (!usage || !usage.live) return;

  // Time elapsed = window - remaining. Position = elapsed / window.
  const sessElapsed = usage.sessionWindowMs - usage.sessionResetMs;
  const sessTimePct = Math.max(0, Math.min(100, (sessElapsed / usage.sessionWindowMs) * 100));

  const weekElapsed = usage.weeklyWindowMs - usage.weeklyResetMs;
  const weekTimePct = Math.max(0, Math.min(100, (weekElapsed / usage.weeklyWindowMs) * 100));

  const sessMarker = document.getElementById('usage-today-marker');
  const sessTrail  = document.getElementById('usage-today-trail');
  const weekMarker = document.getElementById('usage-week-marker');
  const weekTrail  = document.getElementById('usage-week-trail');

  if (sessMarker) sessMarker.style.left = sessTimePct + '%';
  if (sessTrail)  sessTrail.style.left  = 'max(0px, calc(' + sessTimePct + '% - 24px))';
  if (weekMarker) weekMarker.style.left = weekTimePct + '%';
  if (weekTrail)  weekTrail.style.left  = 'max(0px, calc(' + weekTimePct + '% - 24px))';

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


// new-session-btn click is handled inline via onclick

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

    // Robot status bar canvas
    const barCanvas = document.getElementById('robot-bar-canvas');
    if (barCanvas && _animStates['__bar']) {
      if (advance) _animStates['__bar'].frame++;
      drawRobotForSession(barCanvas, '__bar');
    }
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

// ─── Skills search & filter ─────────────────────────────────────────────────
let _allSkills = [];
let _skillFilter = 'all';

function renderSkills() {
  const list = document.getElementById('skills-list');
  if (!list) return;

  const query = (document.getElementById('skills-search') || {}).value || '';
  const q = query.toLowerCase();
  const filtered = _allSkills.filter(s => {
    if (_skillFilter !== 'all' && s.source !== _skillFilter) return false;
    if (q && !s.name.toLowerCase().includes(q) && !(s.description || '').toLowerCase().includes(q)) return false;
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="cap-item" style="color:#a0a0a0;">No skills match</div>';
    return;
  }

  list.innerHTML = filtered.map(s => {
    const badge = s.source === 'user'
      ? '<span class="skill-badge skill-badge-user">USER</span>'
      : '<span class="skill-badge skill-badge-plugin">PLUGIN</span>';
    const desc = s.description
      ? '<div class="skill-desc">' + s.description + '</div>'
      : '';
    return '<div class="skill-item" data-source="' + s.source + '" onclick="vscodeApi.postMessage({type:\\'inputSkill\\',name:\\'/' + s.name + '\\'})"><div><span class="skill-name">/' + s.name + '</span>' + badge + '</div>' + desc + '</div>';
  }).join('');
}

document.getElementById('skills-search').addEventListener('input', renderSkills);

document.querySelectorAll('.skills-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.skills-filter-btn').forEach(b => b.dataset.active = 'false');
    btn.dataset.active = 'true';
    _skillFilter = btn.dataset.filter;
    renderSkills();
  });
});

// ─── Section collapse & drag-to-reorder ─────────────────────────────────────
function toggleSection(header) {
  const open = header.dataset.open !== 'false';
  header.dataset.open = open ? 'false' : 'true';
  saveLayoutState();
}

function togglePin(pinEl) {
  const section = pinEl.closest('.section');
  const root = document.getElementById('root');
  const pinned = pinEl.dataset.pinned !== 'true';
  pinEl.dataset.pinned = String(pinned);
  section.dataset.pinned = String(pinned);

  // Move section: after sticky-top + all pinned sections
  const allSections = [...root.querySelectorAll('.section[draggable]')];
  const lastPinned = allSections.filter(s => s.dataset.pinned === 'true' && s !== section).pop();
  const stickyTop = document.getElementById('sticky-top');
  const insertAfter = lastPinned || stickyTop;
  if (insertAfter && insertAfter.nextSibling) {
    root.insertBefore(section, insertAfter.nextSibling);
  }

  recalcPinOffsets();
  saveLayoutState();
}

function recalcPinOffsets() {
  const stickyTop = document.getElementById('sticky-top');
  let offset = stickyTop ? stickyTop.offsetHeight : 0;
  const sections = document.querySelectorAll('#root > .section[draggable]');
  sections.forEach(s => {
    if (s.dataset.pinned === 'true') {
      s.style.top = offset + 'px';
      offset += s.offsetHeight;
    } else {
      s.style.top = '';
    }
  });
}

function saveLayoutState() {
  const sections = document.querySelectorAll('#root > .section[draggable]');
  const order = [];
  const collapsed = {};
  const pinned = {};
  sections.forEach(s => {
    order.push(s.id);
    const h = s.querySelector('.section-header');
    if (h && h.dataset.open === 'false') collapsed[s.id] = true;
    if (s.dataset.pinned === 'true') pinned[s.id] = true;
  });
  vscodeApi.setState({ sectionOrder: order, sectionCollapsed: collapsed, sectionPinned: pinned });
}

function restoreLayoutState() {
  const state = vscodeApi.getState();
  if (!state) return;
  const root = document.getElementById('root');
  if (state.sectionOrder) {
    const sections = {};
    root.querySelectorAll('.section[draggable]').forEach(s => { sections[s.id] = s; });
    for (const id of state.sectionOrder) {
      if (sections[id]) root.appendChild(sections[id]);
    }
  }
  if (state.sectionCollapsed) {
    for (const [id, val] of Object.entries(state.sectionCollapsed)) {
      if (!val) continue;
      const el = document.getElementById(id);
      if (el) {
        const h = el.querySelector('.section-header');
        if (h) h.dataset.open = 'false';
      }
    }
  }
  if (state.sectionPinned) {
    for (const [id, val] of Object.entries(state.sectionPinned)) {
      if (!val) continue;
      const el = document.getElementById(id);
      if (el) {
        el.dataset.pinned = 'true';
        const pin = el.querySelector('.section-pin');
        if (pin) pin.dataset.pinned = 'true';
      }
    }
    recalcPinOffsets();
  }
}

// Drag to reorder
let _draggedSection = null;
document.querySelectorAll('.section[draggable]').forEach(section => {
  section.addEventListener('dragstart', e => {
    _draggedSection = section;
    section.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  section.addEventListener('dragend', () => {
    section.classList.remove('dragging');
    document.querySelectorAll('.section.drag-over').forEach(s => s.classList.remove('drag-over'));
    _draggedSection = null;
    saveLayoutState();
  });
  section.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (section !== _draggedSection) {
      document.querySelectorAll('.section.drag-over').forEach(s => s.classList.remove('drag-over'));
      section.classList.add('drag-over');
    }
  });
  section.addEventListener('dragleave', () => {
    section.classList.remove('drag-over');
  });
  section.addEventListener('drop', e => {
    e.preventDefault();
    section.classList.remove('drag-over');
    if (_draggedSection && _draggedSection !== section) {
      const root = document.getElementById('root');
      const allSections = [...root.querySelectorAll('.section[draggable]')];
      const dragIdx = allSections.indexOf(_draggedSection);
      const dropIdx = allSections.indexOf(section);
      if (dragIdx < dropIdx) {
        section.after(_draggedSection);
      } else {
        section.before(_draggedSection);
      }
    }
  });
});

restoreLayoutState();

// ─── Boot ───────────────────────────────────────────────────────────────────
vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
