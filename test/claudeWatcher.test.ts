import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { ClaudeWatcher } from '../src/claudeWatcher';
import { StateManager } from '../src/stateManager';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, watch: vi.fn(), existsSync: vi.fn() };
});

describe('ClaudeWatcher', () => {
  let sm: StateManager;
  let watcher: ClaudeWatcher;
  let capturedCb: (() => void) | null = null;
  const mockClose = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.watch).mockImplementation((_path, cb) => {
      capturedCb = cb as () => void;
      return { close: mockClose } as unknown as fs.FSWatcher;
    });
    sm = new StateManager(vi.fn());
    watcher = new ClaudeWatcher(sm);
  });

  afterEach(() => {
    watcher.dispose();
    sm.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('calls sm.onClaudeActive when log dir changes', () => {
    const spy = vi.spyOn(sm, 'onClaudeActive');
    capturedCb!();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('calls sm.onClaudeIdle 3s after the last file change', () => {
    const idleSpy = vi.spyOn(sm, 'onClaudeIdle');
    capturedCb!();
    capturedCb!();
    capturedCb!();
    expect(idleSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(idleSpy).toHaveBeenCalledTimes(1);
  });

  it('resets the debounce timer on each change', () => {
    const idleSpy = vi.spyOn(sm, 'onClaudeIdle');
    capturedCb!();
    vi.advanceTimersByTime(2_000);
    capturedCb!();                          // reset
    vi.advanceTimersByTime(2_000);          // only 2s since last change
    expect(idleSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);          // now 3s
    expect(idleSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the watcher handle on dispose()', () => {
    watcher.dispose();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('does not throw if Claude log directory does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(() => new ClaudeWatcher(sm)).not.toThrow();
  });
});
