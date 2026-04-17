import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { Panel } from './panel';
import { UsagePoint } from './shared/messages';
import { backfillUsageHistory } from './session/usageHistory';

const HISTORY_KEY = 'usageHistory';
const HISTORY_MAX = 10_080; // 7 days at 60s cadence

let sessionManager: SessionManager | undefined;
let panel: Panel | undefined;

export function activate(context: vscode.ExtensionContext) {
  panel = Panel.createProvider(context);

  sessionManager = new SessionManager((sessions) => {
    panel!.sendSessions(sessions);
  });

  // Load persisted usage history (ring buffer capped at HISTORY_MAX)
  let history: UsagePoint[] = context.globalState.get<UsagePoint[]>(HISTORY_KEY, []);
  history = history.filter(p => p && typeof p.ts === 'number' && typeof p.sessionPct === 'number');

  // If we have very little live history, seed the chart from 7 days of JSONL activity.
  // This gives the user an immediate "last week" shape; new live ticks append to this.
  if (history.length < 10) {
    try {
      const seeded = backfillUsageHistory(7);
      if (seeded.length > 0) {
        // Merge: historical points first, then any live points we already had.
        const live = history.slice();
        history = seeded.concat(live).slice(-HISTORY_MAX);
        context.globalState.update(HISTORY_KEY, history);
      }
    } catch { /* back-fill is best-effort */ }
  }

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

  // Send usage stats every 60s + append to history ring buffer
  const usageTick = () => {
    const usage = sessionManager!.computeUsageFromLogs();
    panel!.sendUsage(usage);

    if (usage.live) {
      history.push({
        ts:             Date.now(),
        sessionPct:     usage.sessionPct,
        weeklyPct:      usage.weeklyPct,
        sessionResetMs: usage.sessionResetMs,
        weeklyResetMs:  usage.weeklyResetMs,
      });
      if (history.length > HISTORY_MAX) {
        history = history.slice(-HISTORY_MAX);
      }
      context.globalState.update(HISTORY_KEY, history);
    }
    panel!.sendUsageHistory(history);
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
      clis: sessionManager!.getInstalledClis(),
    });
    panel!.sendProjectInfo();
  };
  envTick();
  const envTimer = setInterval(envTick, 10_000);

  // Fresh data on sidebar open
  panel.onReady(() => { usageTick(); envTick(); });

  // Clear persisted usage history when the user taps the reset button
  panel.onResetUsageHistory(() => {
    history = [];
    context.globalState.update(HISTORY_KEY, history);
    panel!.sendUsageHistory(history);
    // Also sample once so the chart isn't stuck in an empty state
    usageTick();
  });

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
