import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { Panel } from './panel';

const TOKEN_WINDOW_HOURS = 24;

let sessionManager: SessionManager | undefined;
let panel: Panel | undefined;

export function activate(context: vscode.ExtensionContext) {
  panel = Panel.createProvider(context);

  // Each VS Code window runs its own extension host, so scoping the manager
  // to this window's workspace folders makes each window track its own project.
  const onSessions = (sessions: Parameters<Panel['sendSessions']>[0]) => {
    panel!.sendSessions(sessions);
  };
  const workspaceRoots = () =>
    (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

  sessionManager = new SessionManager(onSessions, workspaceRoots());

  // Register sidebar webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claude-code-session.sidebar', panel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Keep the command for opening as an editor panel
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-session.open', () => {
      panel!.openAsPanel();
    })
  );

  const usageTick = () => {
    panel!.sendUsage(sessionManager!.computeUsageFromLogs());
  };
  usageTick();
  const usageTimer = setInterval(usageTick, 60_000);

  const envTick = () => {
    panel!.sendEnvData({
      recentFiles:    sessionManager!.getRecentFiles(),
      mcpServers:     sessionManager!.getMcpServers(),
      recentSessions: sessionManager!.getRecentSessions(),
      skills:         sessionManager!.getSkills(),
      clis:           sessionManager!.getInstalledClis(),
    });
    panel!.sendProjectInfo();
  };
  envTick();
  const envTimer = setInterval(envTick, 10_000);

  // Scan JSONL for the last 24h of token events every 30s
  const tokenTick = () => {
    panel!.sendTokenActivity(
      sessionManager!.getTokenActivity(TOKEN_WINDOW_HOURS),
      TOKEN_WINDOW_HOURS
    );
  };
  tokenTick();
  const tokenTimer = setInterval(tokenTick, 30_000);

  // Fresh data on sidebar open
  panel.onReady(() => { usageTick(); envTick(); tokenTick(); });

  // Folders added/removed in this window → rebuild the manager with the new scope
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      sessionManager?.dispose();
      sessionManager = new SessionManager(onSessions, workspaceRoots());
      envTick();
      tokenTick();
    })
  );

  // Manual refresh from the webview
  panel.onRefreshTokenActivity(() => tokenTick());

  context.subscriptions.push({
    dispose: () => {
      clearInterval(usageTimer);
      clearInterval(envTimer);
      clearInterval(tokenTimer);
      sessionManager?.dispose();
      panel?.dispose();
    },
  });
}

export function deactivate() {
  sessionManager?.dispose();
  panel?.dispose();
}
