import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { ActivityMonitor } from './activityMonitor';
import { ClaudeWatcher } from './claudeWatcher';
import { Panel } from './panel';

let stateManager:    StateManager    | undefined;
let activityMonitor: ActivityMonitor | undefined;
let claudeWatcher:   ClaudeWatcher   | undefined;
let panel:           Panel           | undefined;

export function activate(context: vscode.ExtensionContext) {
  stateManager = new StateManager((state) => {
    panel?.setState(state);
  });

  function openPanel() {
    panel = Panel.create(
      context,
      () => stateManager?.onAnimationDone(),
      openPanel  // reopen when user closes it
    );
  }

  openPanel();
  activityMonitor = new ActivityMonitor(stateManager);
  claudeWatcher   = new ClaudeWatcher(stateManager);
}

export function deactivate() {
  panel?.dispose();
  activityMonitor?.dispose();
  claudeWatcher?.dispose();
  stateManager?.dispose();
}
