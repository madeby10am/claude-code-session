import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { SessionState, UsageStats } from './sessionManager';
import { ExtensionToWebview, WebviewToExtension, EnvData, UsagePoint } from './shared/messages';

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
  private lastEnvData: EnvData | null = null;
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
      this.sendProjectInfo();
      this.sendDarkMode();
      if (this.lastEnvData) {
        this.postMessage({ type: 'envData', data: this.lastEnvData });
      }
      // Send cached usage immediately so bars don't flash 0%
      if (this.lastUsage) {
        this.postMessage({ type: 'usageUpdate', usage: this.lastUsage });
      }
      if (this.lastHistory.length > 0) {
        this.postMessage({ type: 'usageHistory', points: this.lastHistory });
      }
      // Then trigger fresh fetch on top
      if (this.onReadyCallback) { this.onReadyCallback(); }
    }
    if (msg.type === 'refreshUsage') {
      this.sendSessions(this.sessions);
      this.sendProjectInfo();
      if (this.onReadyCallback) { this.onReadyCallback(); }
    }
    if (msg.type === 'resetUsageHistory') {
      if (this.onResetUsageHistoryCallback) { this.onResetUsageHistoryCallback(); }
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

  private postMessage(msg: ExtensionToWebview): void {
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

  private lastHistory: UsagePoint[] = [];
  sendUsageHistory(points: UsagePoint[]): void {
    this.lastHistory = points;
    this.postMessage({ type: 'usageHistory', points });
  }

  private onResetUsageHistoryCallback: (() => void) | null = null;
  onResetUsageHistory(cb: () => void): void { this.onResetUsageHistoryCallback = cb; }

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
