import * as vscode from 'vscode';
import { StateManager } from './stateManager';

export class ActivityMonitor {
  private readonly subscription: vscode.Disposable;

  constructor(stateManager: StateManager) {
    this.subscription = vscode.workspace.onDidChangeTextDocument(() => {
      stateManager.onKeypress();
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
