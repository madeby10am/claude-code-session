import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { UsageStats } from './types';

function readCredentialsFromFile(): string {
  const credPath = join(homedir(), '.claude', '.credentials.json');
  return readFileSync(credPath, 'utf8').trim();
}

function readCredentialsFromKeychain(): string {
  return execFileSync(
    'security',
    ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
    { encoding: 'utf8', timeout: 3000 }
  ).trim();
}

/**
 * Read Claude Code OAuth credentials.
 *
 * - macOS: tries the system Keychain first, falls back to ~/.claude/.credentials.json
 * - Windows / Linux: reads ~/.claude/.credentials.json directly
 */
function readCredentials(): string {
  if (process.platform === 'darwin') {
    try {
      const raw = readCredentialsFromKeychain();
      if (raw) { return raw; }
    } catch { /* keychain unavailable — fall through to file */ }
    return readCredentialsFromFile();
  }
  return readCredentialsFromFile();
}

/**
 * Fetch live usage data by making a minimal API call to read rate limit headers.
 */
export function computeUsageFromLogs(): UsageStats {
  try {
    const raw = readCredentials();
    if (!raw) { throw new Error('no credentials'); }
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (!token) { throw new Error('no token'); }

    const tierRaw = (oauth?.rateLimitTier || '') as string;
    const sub = (oauth?.subscriptionType || '') as string;
    let planTier = 'Free';
    if (tierRaw.includes('max_20x'))     planTier = 'Max 20x';
    else if (tierRaw.includes('max_5x')) planTier = 'Max 5x';
    else if (tierRaw.includes('max'))    planTier = 'Max';
    else if (sub === 'pro')              planTier = 'Pro';

    const result = execFileSync(
      'node',
      ['-e', `
const https=require('https');
const body=JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:1,messages:[{role:'user',content:'h'}]});
const req=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'x-api-key':'${token}','anthropic-version':'2023-06-01','Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
  const h=res.headers;
  const out={sp:parseFloat(h['anthropic-ratelimit-unified-5h-utilization']||'0'),wp:parseFloat(h['anthropic-ratelimit-unified-7d-utilization']||'0'),sr:parseInt(h['anthropic-ratelimit-unified-5h-reset']||'0',10),wr:parseInt(h['anthropic-ratelimit-unified-7d-reset']||'0',10),ov:h['anthropic-ratelimit-unified-overage-in-use']==='true'};
  let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(JSON.stringify(out)));
});
req.on('error',()=>console.log('{}'));
req.write(body);req.end();
`],
      { encoding: 'utf8', timeout: 10000 }
    ).trim();

    if (result) {
      const d = JSON.parse(result);
      const nowSec = Math.floor(Date.now() / 1000);
      return {
        sessionPct:      Math.round(d.sp * 100),
        weeklyPct:       Math.round(d.wp * 100),
        sessionResetMs:  Math.max(0, (d.sr - nowSec) * 1000),
        weeklyResetMs:   Math.max(0, (d.wr - nowSec) * 1000),
        sessionWindowMs: 5 * 60 * 60 * 1000,
        weeklyWindowMs:  7 * 24 * 60 * 60 * 1000,
        live:            true,
        planTier,
        overageInUse:    d.ov === true,
      };
    }
  } catch { /* credentials or API unavailable */ }

  return {
    sessionPct: 0,
    weeklyPct:  0,
    sessionResetMs: 0,
    weeklyResetMs:  0,
    sessionWindowMs: 5 * 60 * 60 * 1000,
    weeklyWindowMs:  7 * 24 * 60 * 60 * 1000,
    live: false,
    planTier: '',
    overageInUse: false,
  };
}
