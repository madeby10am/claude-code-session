import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { Panel } from './panel';

let sessionManager: SessionManager | undefined;
let panel: Panel | undefined;

export function activate(context: vscode.ExtensionContext) {
  panel = Panel.createProvider(context);

  sessionManager = new SessionManager((sessions) => {
    panel!.sendSessions(sessions);
  });

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

  // Send usage stats every 30s
  const usageTick = () => {
    const usage = sessionManager!.computeUsageFromLogs();
    panel!.sendUsage(usage);
  };
  usageTick();
  const usageTimer = setInterval(usageTick, 60_000);

  // Send environment data every 10s
  const envTick = () => {
    panel!.sendEnvData({
      recentFiles: sessionManager!.getRecentFiles(),
      mcpServers: sessionManager!.getMcpServers(),
      recentSessions: sessionManager!.getRecentSessions(),
      skills: sessionManager!.getSkills(),
    });
    panel!.sendProjectInfo();
  };
  envTick();
  const envTimer = setInterval(envTick, 10_000);

  // Fresh data on sidebar open
  panel.onReady(() => { usageTick(); envTick(); });

  context.subscriptions.push({
    dispose: () => {
      clearInterval(usageTimer);
      clearInterval(envTimer);
      sessionManager?.dispose();
      panel?.dispose();
    },
  });
}

export function deactivate() {
  sessionManager?.dispose();
  panel?.dispose();
}
