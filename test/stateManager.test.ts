import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateManager, AnimationState } from '../src/stateManager';

describe('StateManager', () => {
  let sm: StateManager;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onChange = vi.fn();
    sm = new StateManager(onChange);
  });

  afterEach(() => {
    sm.dispose();
    vi.useRealTimers();
  });

  it('starts in typing state', () => {
    expect(sm.getCurrent()).toBe('typing');
  });

  it('transitions to drinking_coffee after 30s idle', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);
    expect(sm.getCurrent()).toBe('drinking_coffee');
    expect(onChange).toHaveBeenCalledWith('drinking_coffee');
  });

  it('transitions to leaning_back when drinking animation ends', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);        // → drinking_coffee
    sm.onAnimationDone();                   // → leaning_back
    expect(sm.getCurrent()).toBe('leaning_back');
  });

  it('transitions to walking after 5min in leaning_back', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);
    sm.onAnimationDone();                   // → leaning_back
    vi.advanceTimersByTime(5 * 60_000);
    expect(sm.getCurrent()).toBe('walking');
  });

  it('transitions to sleeping after 10min in walking', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);
    sm.onAnimationDone();
    vi.advanceTimersByTime(5 * 60_000);     // → walking
    vi.advanceTimersByTime(10 * 60_000);    // → sleeping
    expect(sm.getCurrent()).toBe('sleeping');
  });

  it('any keypress snaps back to typing from any state', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);
    sm.onAnimationDone();                   // → leaning_back
    sm.onKeypress();
    expect(sm.getCurrent()).toBe('typing');
  });

  it('keypress resets the 30s idle timer', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(25_000);
    sm.onKeypress();                        // reset
    vi.advanceTimersByTime(25_000);         // only 25s since last press
    expect(sm.getCurrent()).toBe('typing');
    vi.advanceTimersByTime(5_000);          // now 30s
    expect(sm.getCurrent()).toBe('drinking_coffee');
  });

  it('transitions to stretching after 15min continuous typing', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(15 * 60_000);
    expect(sm.getCurrent()).toBe('stretching');
  });

  it('returns to typing after stretching animation ends', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(15 * 60_000);    // → stretching
    sm.onAnimationDone();                   // → typing
    expect(sm.getCurrent()).toBe('typing');
  });

  it('claude active overrides walking with leaning_back', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);
    sm.onAnimationDone();
    vi.advanceTimersByTime(5 * 60_000);     // → walking
    sm.onClaudeActive();
    expect(sm.getCurrent()).toBe('leaning_back');
  });

  it('claude active does NOT override typing', () => {
    sm.onKeypress();
    sm.onClaudeActive();
    expect(sm.getCurrent()).toBe('typing');
  });

  it('claude active does NOT override stretching', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(15 * 60_000);    // → stretching
    sm.onClaudeActive();
    expect(sm.getCurrent()).toBe('stretching');
  });

  it('does not fire onChange when state is unchanged', () => {
    sm.onKeypress();
    sm.onKeypress();
    expect(onChange).not.toHaveBeenCalled(); // already typing, no change
  });
});
