import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateManager } from './stateManager';

const LOG_DIR     = path.join(os.homedir(), '.config', 'claude', 'logs');
const DEBOUNCE_MS = 3_000;

export class ClaudeWatcher {
  private watcher:       fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly stateManager: StateManager) {
    if (!fs.existsSync(LOG_DIR)) return;

    this.watcher = fs.watch(LOG_DIR, () => {
      this.stateManager.onClaudeActive();
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.stateManager.onClaudeIdle();
      }, DEBOUNCE_MS);
    });
  }

  dispose(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.watcher?.close();
    this.watcher = null;
  }
}
