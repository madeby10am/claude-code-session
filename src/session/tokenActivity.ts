import * as fs   from 'fs';
import * as path from 'path';
import { CLAUDE_PROJECTS_DIR } from './claudeEnvironment';

export interface TokenEvent {
  ts:     number;
  tokens: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function collectRecentJsonlFiles(cutoffTs: number): string[] {
  const out: string[] = [];
  try {
    for (const slug of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const slugDir = path.join(CLAUDE_PROJECTS_DIR, slug);
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

/**
 * Returns every assistant message from the last `hours` hours, each with its real
 * timestamp and real token cost (input + cache_creation + cache_read + output).
 * No estimation — these numbers come straight from the JSONL session logs.
 */
export function getRecentTokenEvents(hours = 24): TokenEvent[] {
  const now      = Date.now();
  const cutoffTs = now - hours * 60 * 60 * 1000;
  const files    = collectRecentJsonlFiles(cutoffTs);
  const events: TokenEvent[] = [];

  for (const filePath of files) {
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf8'); }
    catch { continue; }

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

      const input  = (usage.input_tokens                as number | undefined) ?? 0;
      const cacheC = (usage.cache_creation_input_tokens as number | undefined) ?? 0;
      const cacheR = (usage.cache_read_input_tokens     as number | undefined) ?? 0;
      const output = (usage.output_tokens               as number | undefined) ?? 0;
      const total  = input + cacheC + cacheR + output;
      if (total > 0) events.push({ ts, tokens: total });
    }
  }

  events.sort((a, b) => a.ts - b.ts);
  return events;
}
