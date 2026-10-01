import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';
import { SessionState, UsageStats } from './sessionManager';
import { ExtensionToWebview, WebviewToExtension, EnvData } from './shared/messages';
import { TokenEvent } from './session/tokenActivity';
import { matchSessionByTabLabel } from './session/tabMatch';
import { Dismissed, visibleSessions, dismiss, forgetStale } from './session/dismissed';
import { GitActivity, parseReflog, mergeActivity } from './session/gitActivity';

export class Panel implements vscode.WebviewViewProvider {
  private static instance: Panel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private sidebarView: vscode.WebviewView | undefined;
  private sessions: Map<string, SessionState> = new Map();
  private disposables: vscode.Disposable[] = [];
  private context: vscode.ExtensionContext;
  private projectInfoTimer: ReturnType<typeof setTimeout> | null = null;
  // gh repo view hits the network and execSync blocks the extension host —
  // refresh it far less often than the local git commands.
  private ghCache: { cwd: string; ts: number; json: string } | null = null;
  private static readonly GH_CACHE_MS = 5 * 60 * 1000;
  private terminalMap = new Map<string, vscode.Terminal>();
  private lastUsage: UsageStats | null = null;
  private lastEnvData: EnvData | null = null;
  private onReadyCallback: (() => void) | null = null;
  private focusedSessionId: string | undefined;
  private dismissed: Dismissed = {};
  private static readonly DISMISSED_KEY = 'dismissedSessions';

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.dismissed = forgetStale(context.workspaceState.get<Dismissed>(Panel.DISMISSED_KEY, {}));
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
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'assets'),
        vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
      ],
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
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'assets'),
          vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
        ],
      }
    );

    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage((msg) => this.handleWebviewMessage(msg));

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.registerListeners();
  }

  private handleWebviewMessage(msg: WebviewToExtension): void {
    if (msg.type === 'ready') {
      this.sendSessions(this.sessions);
      this.syncActiveTab(true);
      this.sendProjectInfo();
      if (this.lastEnvData) {
        this.postMessage({ type: 'envData', data: this.lastEnvData });
      }
      // Send cached usage immediately so bars don't flash 0%
      if (this.lastUsage) {
        this.postMessage({ type: 'usageUpdate', usage: this.lastUsage });
      }
      if (this.lastTokenActivity.length > 0) {
        this.postMessage({
          type: 'tokenActivity',
          events: this.lastTokenActivity,
          windowHours: this.lastTokenWindowHours,
        });
      }
      // Then trigger fresh fetch on top
      if (this.onReadyCallback) { this.onReadyCallback(); }
    }
    if (msg.type === 'refreshUsage') {
      this.sendSessions(this.sessions);
      this.sendProjectInfo();
      if (this.onReadyCallback) { this.onReadyCallback(); }
    }
    if (msg.type === 'refreshTokenActivity') {
      if (this.onRefreshTokenActivityCallback) { this.onRefreshTokenActivityCallback(); }
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
    if (msg.type === 'dismissSession' && msg.sessionId) {
      this.dismissSession(msg.sessionId);
    }
    if (msg.type === 'openSession' && msg.sessionId) {
      void this.focusSession(msg.sessionId);
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

  private static isClaudeTab(tab: vscode.Tab): tab is vscode.Tab & { input: vscode.TabInputWebview } {
    return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('claudeVSCodePanel');
  }

  private isTabFor(tab: vscode.Tab, sessionId: string): boolean {
    return Panel.isClaudeTab(tab) && matchSessionByTabLabel(tab.label, this.sessions.values()) === sessionId;
  }

  // Bring an already-open Claude editor tab for this session to the front.
  private async revealSessionTab(sessionId: string): Promise<boolean> {
    const groupCmds = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
    for (const group of vscode.window.tabGroups.all) {
      const index = group.tabs.findIndex(t => this.isTabFor(t, sessionId));
      const cmd = groupCmds[group.viewColumn - 1];
      if (index < 0 || !cmd) { continue; }
      await vscode.commands.executeCommand(`workbench.action.focus${cmd}EditorGroup`);
      await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index);
      return true;
    }
    return false;
  }

  private async focusSession(sessionId: string): Promise<void> {
    // 1. A terminal we opened earlier for this session
    const mapped = this.terminalMap.get(sessionId);
    if (mapped) {
      mapped.show();
      return;
    }

    // 2. An open Claude editor tab for this session
    if (await this.revealSessionTab(sessionId)) { return; }

    // 3. A terminal whose name carries the sessionId prefix
    const prefix = sessionId.slice(0, 8);
    const existing = vscode.window.terminals.find(t => t.name.includes(prefix));
    if (existing) {
      existing.show();
      return;
    }

    // 4. Not open anywhere: reopen in the Claude editor, falling back to a resumed terminal
    if (this.sessions.get(sessionId)?.entrypoint === 'claude-vscode') {
      try {
        await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
        return;
      } catch { /* extension missing or command changed: use the terminal */ }
    }
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

    // Clicking a different Claude tab jumps the sidebar to that session.
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(e => {
        this.onTabsClosed(e.closed);
        this.syncActiveTab();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.syncActiveTab())
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

  // Resolve the active editor tab to a session and tell the webview.
  // Non-Claude tabs (files, etc.) leave the current selection alone.
  private syncActiveTab(force = false): void {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!tab || !Panel.isClaudeTab(tab)) { return; }
    const id = matchSessionByTabLabel(tab.label, visibleSessions(this.sessions.values(), this.dismissed));
    if (!id || (!force && id === this.focusedSessionId)) { return; }
    this.focusedSessionId = id;
    this.postMessage({ type: 'focusSession', sessionId: id });
  }

  // Hide a session once its Claude editor tab is closed. The log file outlives the
  // tab, so without this the session would linger in the list for up to an hour.
  private onTabsClosed(closed: readonly vscode.Tab[]): void {
    for (const tab of closed) {
      if (!Panel.isClaudeTab(tab)) { continue; }
      const id = matchSessionByTabLabel(tab.label, this.sessions.values());
      if (!id) { continue; }
      // A tab dragged to another group reports as closed then reopened: re-check shortly.
      setTimeout(() => {
        if (!this.hasOpenTab(id)) { this.dismissSession(id); }
      }, 300);
    }
  }

  private hasOpenTab(sessionId: string): boolean {
    return vscode.window.tabGroups.all.some(g => g.tabs.some(t => this.isTabFor(t, sessionId)));
  }

  private dismissSession(sessionId: string): void {
    this.dismissed = dismiss(forgetStale(this.dismissed), sessionId);
    void this.context.workspaceState.update(Panel.DISMISSED_KEY, this.dismissed);
    if (this.focusedSessionId === sessionId) { this.focusedSessionId = undefined; }
    this.sendSessions(this.sessions);
  }

  private postMessage(msg: ExtensionToWebview): void {
    this.sidebarView?.webview.postMessage(msg);
    this.panel?.webview.postMessage(msg);
  }

  sendSessions(sessions: Map<string, SessionState>): void {
    this.sessions = sessions;
    this.postMessage({
      type: 'sessionsUpdate',
      sessions: visibleSessions(sessions.values(), this.dismissed),
    });
    // A tab's chat title may only appear in the log after the tab opens.
    this.syncActiveTab();
  }

  onReady(callback: () => void): void {
    this.onReadyCallback = callback;
  }

  sendUsage(usage: UsageStats): void {
    this.lastUsage = usage;
    this.postMessage({ type: 'usageUpdate', usage });
  }

  private lastTokenActivity: TokenEvent[] = [];
  private lastTokenWindowHours = 24;
  sendTokenActivity(events: TokenEvent[], windowHours = 24): void {
    this.lastTokenActivity  = events;
    this.lastTokenWindowHours = windowHours;
    this.postMessage({ type: 'tokenActivity', events, windowHours });
  }

  private onRefreshTokenActivityCallback: (() => void) | null = null;
  onRefreshTokenActivity(cb: () => void): void { this.onRefreshTokenActivityCallback = cb; }

  sendEnvData(data: EnvData): void {
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
    let gitLastCommit = '';
    let uncommittedCount = 0;
    let ahead = 0;
    let behind = 0;
    let stashCount = 0;
    let isPrivate: boolean | null = null;
    let openIssues = 0;
    let openPRs = 0;
    let activity: GitActivity[] = [];

    const git = (cmd: string): string => {
      try { return execSync(cmd, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
      catch { return ''; }
    };

    // No shell: branch names are attacker-controlled (a cloned repo can name one `a;cmd`).
    const gitArgs = (...args: string[]): string => {
      try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
      catch { return ''; }
    };

    if (cwd) {
      gitBranch = git('git rev-parse --abbrev-ref HEAD');
      const remote = git('git remote get-url origin');
      if (remote) {
        const match = remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
        gitRemote = match ? match[1] : remote;
      }
      gitLastCommit = git('git log -1 --format=%s');
      const status = git('git status --porcelain');
      uncommittedCount = status ? status.split('\n').length : 0;
      ahead = parseInt(git('git rev-list @{u}..HEAD --count'), 10) || 0;
      behind = parseInt(git('git rev-list HEAD..@{u} --count'), 10) || 0;
      const stashOut = git('git stash list');
      stashCount = stashOut ? stashOut.split('\n').length : 0;

      // Recent activity: HEAD reflog (commits/merges/pulls) + the remote
      // branch's reflog, which is where pushes are recorded.
      const reflog = (ref: string, n: string) =>
        gitArgs('reflog', 'show', ref, '-n', n, '--date=unix', '--format=%gd%x09%gs');
      const lists = [parseReflog(reflog('HEAD', '40'), 'head')];
      if (gitBranch && gitBranch !== 'HEAD') {
        lists.push(parseReflog(reflog(`refs/remotes/origin/${gitBranch}`, '20'), 'remote'));
      }
      activity = mergeActivity(lists);

      // GitHub API data via gh CLI (cached — see GH_CACHE_MS)
      let ghJson: string;
      if (this.ghCache && this.ghCache.cwd === cwd &&
          Date.now() - this.ghCache.ts < Panel.GH_CACHE_MS) {
        ghJson = this.ghCache.json;
      } else {
        ghJson = git('gh repo view --json isPrivate,issues,pullRequests 2>/dev/null');
        this.ghCache = { cwd, ts: Date.now(), json: ghJson };
      }
      if (ghJson) {
        try {
          const gh = JSON.parse(ghJson);
          isPrivate = gh.isPrivate ?? null;
          openIssues = gh.issues?.totalCount ?? 0;
          openPRs = gh.pullRequests?.totalCount ?? 0;
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
        gitLastCommit,
        uncommittedCount,
        ahead,
        behind,
        stashCount,
        isPrivate,
        openIssues,
        openPRs,
        activity,
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

  private static _cachedAssets: { [k: string]: string } = {};
  private static readWebviewAsset(name: string): string {
    if (!Panel._cachedAssets[name]) {
      Panel._cachedAssets[name] = fs.readFileSync(
        path.join(__dirname, "webview", name),
        "utf8"
      );
    }
    return Panel._cachedAssets[name];
  }

  private buildHtml(webview: vscode.Webview): string {
    const robotUri  = this.getRobotSpriteUri(webview);
    const bundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "webview", "bundle.js")
    ).toString();
    const styles = Panel.readWebviewAsset("styles.css");
    const body   = Panel.readWebviewAsset("body.html");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${webview.cspSource};">
<style>${styles}</style>
</head>
<body>
${body}
<script>window.__ROBOT_URI__ = ${JSON.stringify(robotUri)};</script>
<script src="${bundleUri}"></script>
</body>
</html>`;
  }
}
