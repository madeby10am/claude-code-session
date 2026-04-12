import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityMonitor } from '../src/activityMonitor';
import { StateManager } from '../src/stateManager';

vi.mock('vscode', () => ({
  workspace: {
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

describe('ActivityMonitor', () => {
  let sm: StateManager;
  let monitor: ActivityMonitor;
  let capturedCb: (() => void) | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    const vscode = await import('vscode');
    vi.mocked(vscode.workspace.onDidChangeTextDocument).mockImplementation((cb) => {
      capturedCb = cb as () => void;
      return { dispose: vi.fn() };
    });
    sm = new StateManager(vi.fn());
    monitor = new ActivityMonitor(sm);
  });

  afterEach(() => {
    monitor.dispose();
    sm.dispose();
    vi.useRealTimers();
  });

  it('calls sm.onKeypress when a text document changes', () => {
    const spy = vi.spyOn(sm, 'onKeypress');
    capturedCb!();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('calls sm.onKeypress for each document change event', () => {
    const spy = vi.spyOn(sm, 'onKeypress');
    capturedCb!();
    capturedCb!();
    capturedCb!();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('disposes the VS Code subscription on dispose()', async () => {
    const disposeSpy = vi.fn();
    const vscode = await import('vscode');
    vi.mocked(vscode.workspace.onDidChangeTextDocument).mockReturnValueOnce({
      dispose: disposeSpy,
    });
    const m2 = new ActivityMonitor(sm);
    m2.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
