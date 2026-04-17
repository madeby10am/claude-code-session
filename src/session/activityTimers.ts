import { SessionEntry } from './types';

export const IDLE_TIMEOUT_MS  = 10 * 1000;
export const SLEEP_TIMEOUT_MS = 2 * 60 * 1000;

export function clearEntryTimers(entry: SessionEntry): void {
  if (entry.idleTimer !== null) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  if (entry.sleepTimer !== null) {
    clearTimeout(entry.sleepTimer);
    entry.sleepTimer = null;
  }
}

/**
 * Reset the idle and sleep timers for an entry.
 * After 10s of no new data → thinking (if mid-work) or idle.
 * After 2min of no new data → sleeping.
 */
export function resetTimers(entry: SessionEntry, onChange: () => void): void {
  clearEntryTimers(entry);

  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    if (entry.state.activity === 'sleeping') { return; }
    if (entry.state.activity === 'user_sent' || entry.state.activity === 'tooling') {
      entry.state.activity = 'thinking';
    } else if (entry.state.activity !== 'thinking') {
      entry.state.activity = 'idle';
    }
    onChange();
  }, IDLE_TIMEOUT_MS);

  entry.sleepTimer = setTimeout(() => {
    entry.sleepTimer = null;
    entry.state.activity = 'sleeping';
    onChange();
  }, SLEEP_TIMEOUT_MS);
}
