import * as fs   from 'fs';
import * as path from 'path';
import { CLAUDE_PROJECTS_DIR } from './claudeEnvironment';
import { UsagePoint } from '../shared/messages';

const FIVE_HOURS_MS = 5  * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7  * 24 * 60 * 60 * 1000;
const BUCKET_MS     = 15 * 60 * 1000;           // 15 min resolution per emitted point

// Estimated "full" quotas, used only to translate raw token volume into a % shape.
// Numbers are deliberately coarse — the goal is to produce a stock-chart shape from
// historical activity, not to match the real Max 5x / Max 20x / Pro quotas.
const SESSION_QUOTA = 10_000_000;
const WEEKLY_QUOTA  = 100_000_000;

interface TokenEvent {
  ts:     number;
  tokens: number;
}

function collectJsonlFiles(root: string, cutoffTs: number): string[] {
  const out: string[] = [];
  try {
    for (const slug of fs.readdirSync(root)) {
      const slugDir = path.join(root, slug);
      let stat: fs.Stats;
      try { stat = fs.statSync(slugDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      try {
        for (const f of fs.readdirSync(slugDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const full = path.join(slugDir, f);
          try {
            const s = fs.statSync(full);
            if (s.mtimeMs >= cutoffTs) out.push(full);
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out;
}

function extractTokenEvents(filePath: string, cutoffTs: number): TokenEvent[] {
  const events: TokenEvent[] = [];
  let content: string;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch { return events; }

  for (const line of content.split('\n')) {
    if (!line || !line.includes('"usage"')) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== 'assistant') continue;

    const tsRaw = obj.timestamp;
    const ts = typeof tsRaw === 'string' ? Date.parse(tsRaw)
              : typeof tsRaw === 'number' ? tsRaw
              : NaN;
    if (!ts || isNaN(ts) || ts < cutoffTs) continue;

    const usage = obj.message?.usage ?? obj.usage;
    if (!usage) continue;

    const input  = (usage.input_tokens              as number | undefined) ?? 0;
    const cacheC = (usage.cache_creation_input_tokens as number | undefined) ?? 0;
    const cacheR = (usage.cache_read_input_tokens     as number | undefined) ?? 0;
    const output = (usage.output_tokens             as number | undefined) ?? 0;
    const total  = input + cacheC + cacheR + output;
    if (total > 0) events.push({ ts, tokens: total });
  }
  return events;
}

/**
 * Scan ~/.claude/projects/**.jsonl to build an approximate 7-day usage curve.
 * Emits one UsagePoint per BUCKET_MS. Session% is the last-5h-rolling token sum
 * against SESSION_QUOTA; Weekly% is the last-7d-rolling sum against WEEKLY_QUOTA.
 * resetMs fields encode the timing-line position so the webview can color by pace.
 */
export function backfillUsageHistory(days = 7): UsagePoint[] {
  const now      = Date.now();
  const cutoffTs = now - days * 24 * 60 * 60 * 1000;

  const files  = collectJsonlFiles(CLAUDE_PROJECTS_DIR, cutoffTs - FIVE_HOURS_MS);
  const events: TokenEvent[] = [];
  for (const f of files) events.push(...extractTokenEvents(f, cutoffTs - FIVE_HOURS_MS));
  events.sort((a, b) => a.ts - b.ts);
  if (events.length === 0) return [];

  const firstTs = Math.max(cutoffTs, events[0].ts);
  const points: UsagePoint[] = [];

  // Sliding windows via pointers — O(n + buckets) instead of rescanning events per bucket.
  let sessionStart = 0;
  let weeklyStart  = 0;
  let sessionSum   = 0;
  let weeklySum    = 0;
  let eventIdx     = 0;

  for (let t = firstTs; t <= now; t += BUCKET_MS) {
    // Absorb all events with ts <= t into both windows
    while (eventIdx < events.length && events[eventIdx].ts <= t) {
      sessionSum += events[eventIdx].tokens;
      weeklySum  += events[eventIdx].tokens;
      eventIdx++;
    }
    // Drop events that fell out of the 5h window
    while (sessionStart < events.length && events[sessionStart].ts <= t - FIVE_HOURS_MS) {
      sessionSum -= events[sessionStart].tokens;
      sessionStart++;
    }
    // Drop events that fell out of the 7d window
    while (weeklyStart < events.length && events[weeklyStart].ts <= t - SEVEN_DAYS_MS) {
      weeklySum -= events[weeklyStart].tokens;
      weeklyStart++;
    }

    const sessionPct = Math.min(100, Math.round((sessionSum / SESSION_QUOTA) * 100));
    const weeklyPct  = Math.min(100, Math.round((weeklySum  / WEEKLY_QUOTA)  * 100));

    // Historical points leave resetMs undefined — the webview falls back to
    // percentage-level coloring (low=green, high=red) instead of pace-based.
    points.push({ ts: t, sessionPct, weeklyPct });
  }

  return points;
}
