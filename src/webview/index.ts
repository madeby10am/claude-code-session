// Webview entry point. Bundled by esbuild into out/webview/bundle.js.
// The outer panel.ts HTML template injects window.__ROBOT_URI__ before this script runs,
// and keeps script-src 'unsafe-inline' so inline onclick handlers can still call the
// functions we expose on window at the bottom of this file.

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  setState: (state: unknown) => void;
  getState: () => any;
};
const vscodeApi = acquireVsCodeApi();

// ─── Activity labels ────────────────────────────────────────────────────────
const ACTIVITY_LABELS = {
  idle:       'Idle',
  thinking:   'Thinking',
  user_sent:  'Waiting',
  tooling:    'Working',
  responding: 'Responding',
  sleeping:   'Sleeping',
};

const ENTRYPOINT_LABELS = { 'claude-vscode': 'VS Code', 'cli': 'CLI', 'claude-desktop': 'Desktop' };

const ACTIVE_STATES = new Set(['tooling', 'user_sent', 'thinking', 'responding']);

// ─── Formatting helpers ─────────────────────────────────────────────────────
function fmtTokens(n) {
  if (!n || n <= 0) return '\u2014';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function ctxLevel(pct) {
  if (pct >= 90) return 'red';
  if (pct >= 75) return 'orange';
  if (pct >= 50) return 'yellow';
  if (pct >= 25) return 'yellow-green';
  return 'green';
}

const LEVEL_RANK = { 'green': 1, 'yellow-green': 2, 'yellow': 3, 'orange': 4, 'red': 5 };
function worseLevel(a, b) {
  return (LEVEL_RANK[a] || 0) >= (LEVEL_RANK[b] || 0) ? a : b;
}

function fmtTime(ts) {
  if (!ts) return '\u2014';
  const d = new Date(ts);
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return h12 + ':' + m + ' ' + ampm;
}

function fmtDuration(startTs) {
  if (!startTs) return '\u2014';
  const elapsed = Date.now() - startTs;
  const totalSecs = Math.floor(elapsed / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hrs > 0) return hrs + 'h ' + mins.toString().padStart(2, '0') + 'm ' + secs.toString().padStart(2, '0') + 's';
  if (mins > 0) return mins + 'm ' + secs.toString().padStart(2, '0') + 's';
  return secs + 's';
}

function fmtAgo(ts) {
  if (!ts) return '\u2014';
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

// ─── Build session card ─────────────────────────────────────────────────────
function buildCard(s) {
  const card = document.createElement('div');
  card.className = 'session-card';
  card.dataset.sessionId = s.sessionId;
  card.dataset.activity = s.activity;
  card.style.cursor = 'pointer';
  card.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'openSession', sessionId: s.sessionId });
  });

  const label = ACTIVITY_LABELS[s.activity] || s.activity;
  const isActive = ACTIVE_STATES.has(s.activity);
  const model = s.model ? s.model.replace('claude-', '').replace(/-(\d+)-(\d+).*/, ' $1.$2').replace(/(\w)/, c => c.toUpperCase()) : '\u2014';
  const pct = s.contextPct > 0 ? s.contextPct : 0;
  const level = ctxLevel(pct);

  const displayName = s.chatTitle || s.projectName || s.slug;

  const entryLabel = ENTRYPOINT_LABELS[s.entrypoint] || s.entrypoint || '\u2014';

  // Map permission mode to friendly label
  const MODE_LABELS = {
    'default': 'Ask Before Edit',
    'plan': 'Plan Mode',
    'auto-edit': 'Auto Edit',
    'full-auto': 'Full Auto',
    'bypassPermissions': 'YOLO',
    'none': 'None',
  };
  const modeLabel = MODE_LABELS[s.permissionMode] || s.permissionMode || '\u2014';

  card.innerHTML = `
    <div class="card-top">
      <span class="status-dot" data-status="${s.activity}" data-active="${isActive}"></span>
      <span class="session-name">${displayName}</span>
      ${s.activity === 'idle'
        ? '<span class="your-turn-badge"><span class="your-turn-dot"></span>YOUR TURN</span>'
        : `<span class="activity-badge"><span class="activity-dot"></span>${label}</span>`
      }
    </div>
    <div class="stats-grid">
      <div class="stat-row">
        <span class="stat-label">Model</span>
        <span class="stat-value">${model}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">File</span>
        <span class="stat-value" title="${s.currentFile || ''}">${s.currentFile || '\u2014'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Mode</span>
        <span class="stat-value">${modeLabel}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Source</span>
        <span class="stat-value">${entryLabel}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Turns</span>
        <span class="stat-value">${s.turnCount > 0 ? s.turnCount : '\u2014'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Tools</span>
        <span class="stat-value">${s.toolUseCount > 0 ? s.toolUseCount : '\u2014'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">In</span>
        <span class="stat-value">${fmtTokens(s.lastInputTokens)}<span class="stat-dim"> / ${fmtTokens(s.inputTokens)}</span></span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Out</span>
        <span class="stat-value">${fmtTokens(s.lastOutputTokens)}<span class="stat-dim"> / ${fmtTokens(s.outputTokens)}</span></span>
      </div>
      <div class="context-bar-wrap">
        <div class="context-bar-label">
          <span class="stat-label">Context</span>
          <span class="stat-value">${pct > 0 ? pct + '%' : '\u2014'}</span>
        </div>
        <div class="context-bar-track">
          <div class="context-bar-fill" data-level="${level}" style="width:${pct}%"></div>
        </div>
      </div>
    </div>
    <div class="session-time">
      <span class="session-time-item">Started ${fmtTime(s.startedAt)}</span>
      <span class="session-time-item">&middot;</span>
      <span class="session-time-item" data-duration-start="${s.startedAt}">${fmtDuration(s.startedAt)}</span>
      <button class="card-refresh-btn" title="New session" onclick="event.stopPropagation();vscodeApi.postMessage({type:'newSession'});">+</button>
    </div>
  `;

  return card;
}

// ─── Render sessions ────────────────────────────────────────────────────────
function renderSessions(sessions) {
  const list = document.getElementById('session-list');

  // Sort by most recent first
  const sorted = (sessions || [])
    .slice()
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  if (sorted.length === 0) {
    list.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'empty-state'; d.id = 'empty-msg';
    d.innerHTML = '<div class="empty-icon">&#x25CB;</div>No active Claude session';
    list.appendChild(d);
    return;
  }

  // Only show the current (most recent) session
  const current = [sorted[0]];

  list.innerHTML = '';
  for (const s of current) {
    list.appendChild(buildCard(s));
  }

  // Re-apply cached usage data to the newly built card
  if (_lastUsage) updateUsageMeters(_lastUsage);

  // Update per-card animations
  updateAllAnimations(current);

  // Update robot status bar
  if (sorted.length > 0) {
    const s = sorted[0];
    const txt = document.getElementById('robot-bar-text');
    const isWorking = ACTIVE_STATES.has(s.activity);
    if (txt) {
      const showAction = isWorking && s.activity !== 'thinking' && s.lastAction;
      const raw = showAction ? s.lastAction : (ACTIVITY_LABELS[s.activity] || 'Idle');
      const spaceIdx = raw.indexOf(' ');
      if (spaceIdx > 0 && isWorking) {
        const verb = raw.slice(0, spaceIdx);
        const target = raw.slice(spaceIdx + 1);
        txt.innerHTML = verb + ' <span class="action-target">' + target.replace(/</g, '&lt;') + '</span>';
      } else {
        txt.textContent = raw;
      }
    }
    // Drive robot bar animation
    const newAnim = pickAnim(s.activity, s.lastAction);
    if (!_animStates['__bar'] || _animStates['__bar'].anim !== newAnim) {
      _animStates['__bar'] = { anim: newAnim, frame: 0 };
    }
  }
}

// ─── Message handling ───────────────────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;

  if (msg.type === 'sessionsUpdate') {
    renderSessions(msg.sessions);
  }

  if (msg.type === 'projectInfo') {
    const d = msg.data;
    const ws = document.getElementById('pi-workspace');
    const pp = document.getElementById('pi-path');
    if (ws) ws.textContent = d.workspace || '\u2014';
    if (pp) {
      pp.textContent = d.workspacePath || '';
      pp.title = d.workspacePath || '';
      pp.dataset.path = d.workspacePath || '';
    }

    // Git status section
    const gr = document.getElementById('git-repo');
    if (gr) {
      if (d.gitRemote) {
        gr.innerHTML = '<a class="link" onclick="vscodeApi.postMessage({type:\'openUrl\',url:\'https://github.com/' + d.gitRemote + '\'})">' + d.gitRemote + '</a>';
      } else {
        gr.textContent = '\u2014';
      }
    }
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const fmtDate = (iso) => {
      if (!iso) return '\u2014';
      const dt = new Date(iso);
      return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    };

    setEl('git-branch2', d.gitBranch || '\u2014');
    setEl('git-uncommitted', d.uncommittedCount > 0 ? d.uncommittedCount + ' uncommitted' : 'Clean');
    setEl('git-ahead-behind', '\u2191' + (d.ahead || 0) + ' \u2193' + (d.behind || 0));
    const glc = document.getElementById('git-last-commit');
    if (glc) { glc.textContent = d.gitLastCommit || '\u2014'; glc.title = d.gitLastCommit || ''; }
    setEl('git-last-commit-date', fmtDate(d.lastCommitDate));
    setEl('git-total-commits', d.totalCommits > 0 ? String(d.totalCommits) : '\u2014');
    setEl('git-contributors', d.contributors > 0 ? String(d.contributors) : '\u2014');
    setEl('git-branch-count', d.branchCount > 0 ? String(d.branchCount) : '\u2014');
    setEl('git-tags', d.tagCount > 0 ? String(d.tagCount) : '0');
    setEl('git-stashes', d.stashCount > 0 ? String(d.stashCount) : '0');

    // GitHub API fields
    setEl('git-visibility', d.isPrivate === true ? 'Private' : d.isPrivate === false ? 'Public' : '\u2014');
    setEl('git-stars', d.stars != null ? String(d.stars) : '\u2014');
    setEl('git-forks', d.forks != null ? String(d.forks) : '\u2014');
    setEl('git-issues', d.openIssues != null ? String(d.openIssues) : '\u2014');
    setEl('git-prs', d.openPRs != null ? String(d.openPRs) : '\u2014');
    setEl('git-last-pushed', fmtDate(d.lastPushed));
    setEl('git-created', fmtDate(d.repoCreated));
    setEl('git-size', d.diskUsage || '\u2014');
  }

  if (msg.type === 'envData') {
    const d = msg.data;

    // Recent files
    const rfList = document.getElementById('recent-files-list');
    if (rfList) {
      if (d.recentFiles && d.recentFiles.length > 0) {
        rfList.innerHTML = d.recentFiles.map(f =>
          '<div class="cap-item"><span class="cap-dot" data-status="detected"></span><a class="link" onclick="vscodeApi.postMessage({type:\'openFile\',file:\'' + f + '\'})">' + f + '</a></div>'
        ).join('');
      } else {
        rfList.innerHTML = '<div class="cap-item" style="color:#a0a0a0;">No files yet</div>';
      }
    }

    // MCP servers
    const mcpList = document.getElementById('mcp-list');
    if (mcpList) {
      if (d.mcpServers && d.mcpServers.length > 0) {
        mcpList.innerHTML = d.mcpServers.map(s =>
          '<div class="cap-item"><span class="cap-dot" data-status="connected"></span><span>' + s + '</span></div>'
        ).join('');
      } else {
        mcpList.innerHTML = '<div class="cap-item" style="color:#a0a0a0;">None configured</div>';
      }
    }

    // Skills
    _allSkills = d.skills || [];
    renderSkills();

    // CLIs
    renderClis(d.clis || []);

    // Session history
    const shList = document.getElementById('session-history-list');
    if (shList) {
      if (d.recentSessions && d.recentSessions.length > 0) {
        shList.innerHTML = d.recentSessions.map(s => {
          const ago = fmtAgo(s.lastSeen);
          const dot = ACTIVE_STATES.has(s.activity) ? 'connected' : (s.activity === 'sleeping' ? 'no' : 'detected');
          const title = s.title.length > 28 ? s.title.slice(0, 28) + '\u2026' : s.title;
          return '<div class="cap-item" style="justify-content:space-between;"><span style="display:flex;align-items:center;gap:6px;min-width:0;"><span class="cap-dot" data-status="' + dot + '"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + title + '</span></span><span style="color:#a0a0a0;font-size:10px;flex-shrink:0;">' + ago + '</span></div>';
        }).join('');
      } else {
        shList.innerHTML = '<div class="cap-item" style="color:#a0a0a0;">No sessions</div>';
      }
    }
  }

  if (msg.type === 'usageUpdate') {
    updateUsageMeters(msg.usage);
  }

  if (msg.type === 'tokenActivity') {
    renderTokenActivity(msg.events || []);
  }

  if (msg.type === 'darkMode') {
    applyDarkMode(msg.value);
  }
});

// ─── Duration ticker — updates elapsed time every 1s ───────────────────────
setInterval(() => {
  const els = document.querySelectorAll('[data-duration-start]');
  els.forEach(el => {
    const start = parseInt(el.dataset.durationStart, 10);
    if (start) el.textContent = fmtDuration(start);
  });
}, 1000);

// ─── Usage refresh ─────────────────────────────────────────────────────────
function refreshUsage() {
  // Reset bars and markers to 0, force reflow, then fetch — gives the "fill up" animation
  const sessBar = document.getElementById('usage-today-bar');
  const weekBar = document.getElementById('usage-week-bar');
  const sessMarker = document.getElementById('usage-today-marker');
  const weekMarker = document.getElementById('usage-week-marker');

  // Disable transitions, snap to 0
  [sessBar, weekBar].forEach(el => { if (el) { el.style.transition = 'none'; el.style.width = '0%'; } });
  [sessMarker, weekMarker].forEach(el => { if (el) { el.style.transition = 'none'; el.style.left = '0%'; } });

  // Force reflow so the browser registers 0% before we re-enable transitions
  if (sessBar) sessBar.offsetWidth;

  // Re-enable transitions
  requestAnimationFrame(() => {
    [sessBar, weekBar].forEach(el => { if (el) el.style.transition = ''; });
    [sessMarker, weekMarker].forEach(el => { if (el) el.style.transition = ''; });
    vscodeApi.postMessage({ type: 'refreshUsage' });
  });
}

// ─── Usage meters ──────────────────────────────────────────────────────────
function fmtResetIn(ms) {
  if (ms <= 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return 'resets in ' + mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return 'resets in ' + hrs + 'h ' + (mins % 60) + 'm';
  return 'resets in ' + Math.floor(hrs / 24) + 'd';
}

// Store usage data for time marker animation
let _lastUsage = null;

// Delta-based pace level: how far ahead or behind the timing marker the usage bar is.
// Negative delta = under-pacing (green territory); positive = outpacing (warming up).
function paceLevel(usagePct, timePct) {
  const delta = usagePct - timePct;
  if (delta <= -20) return 'green';         // deeply behind the line → dark green
  if (delta <= -5)  return 'yellow-green';  // slightly behind → lighter green
  if (delta <= 5)   return 'yellow';        // about on pace / just crossed
  if (delta <= 20)  return 'orange';        // moderately ahead
  return 'red';                              // way ahead / burning fast
}

function updateUsageMeters(usage) {
  if (!usage) return;
  _lastUsage = usage;
  _lastUsageTime = Date.now();

  const sessPct = Math.round(usage.sessionPct);
  const weekPct = Math.round(usage.weeklyPct);

  const sessReset = fmtResetIn(usage.sessionResetMs);
  const weekReset = fmtResetIn(usage.weeklyResetMs);

  const sessVal = document.getElementById('usage-today-value');
  const weekVal = document.getElementById('usage-week-value');

  const planEl = document.getElementById('usage-plan-label');

  const isExtra = !!(usage.overageInUse) || sessPct >= 100 || weekPct >= 100;

  if (usage.live) {
    if (sessVal) sessVal.innerHTML = (sessReset ? '<span style="color:var(--text-muted);font-weight:400;font-size:9px;">' + sessReset + '</span> ' : '') + sessPct + '%';
    if (weekVal) weekVal.innerHTML = (weekReset ? '<span style="color:var(--text-muted);font-weight:400;font-size:9px;">' + weekReset + '</span> ' : '') + weekPct + '%';
    if (planEl) {
      var label = usage.planTier ? 'Claude ' + usage.planTier : '';
      planEl.innerHTML = isExtra
        ? label + ' <span class="extra-usage-badge">EXTRA USAGE</span>'
        : label;
    }
  } else {
    if (sessVal) sessVal.textContent = 'No credentials found';
    if (weekVal) weekVal.textContent = '';
    if (planEl) planEl.innerHTML = '';
  }

  const sessBar = document.getElementById('usage-today-bar');
  const weekBar = document.getElementById('usage-week-bar');

  // Pace-based coloring: delta between usage% and time-elapsed% drives the color.
  // Behind the timing line → green; ahead → yellow/orange/red.
  const sessTimePct = usage.live ? Math.max(0, Math.min(100, ((usage.sessionWindowMs - usage.sessionResetMs) / usage.sessionWindowMs) * 100)) : sessPct;
  const weekTimePct = usage.live ? Math.max(0, Math.min(100, ((usage.weeklyWindowMs  - usage.weeklyResetMs)  / usage.weeklyWindowMs)  * 100)) : weekPct;
  const sessLevel = paceLevel(sessPct, sessTimePct);
  const weekLevel = paceLevel(weekPct, weekTimePct);

  if (sessBar) { sessBar.style.width = Math.min(100, sessPct) + '%'; sessBar.dataset.level = sessLevel; }
  if (weekBar) { weekBar.style.width = Math.min(100, weekPct) + '%'; weekBar.dataset.level = weekLevel; }

  const usageCard = document.querySelector('.usage-card');
  if (usageCard) usageCard.dataset.level = worseLevel(sessLevel, weekLevel);

  updateTimeMarkers(usage);
}

let _lastUsageTime = Date.now();

function updateTimeMarkers(usage) {
  if (!usage || !usage.live) return;

  // Time elapsed = window - remaining. Position = elapsed / window.
  const sessElapsed = usage.sessionWindowMs - usage.sessionResetMs;
  const sessTimePct = Math.max(0, Math.min(100, (sessElapsed / usage.sessionWindowMs) * 100));

  const weekElapsed = usage.weeklyWindowMs - usage.weeklyResetMs;
  const weekTimePct = Math.max(0, Math.min(100, (weekElapsed / usage.weeklyWindowMs) * 100));

  const sessMarker = document.getElementById('usage-today-marker');
  const weekMarker = document.getElementById('usage-week-marker');

  if (sessMarker) sessMarker.style.left = sessTimePct + '%';
  if (weekMarker) weekMarker.style.left = weekTimePct + '%';

}

// ─── Token Activity line chart ──────────────────────────────────────────────
// Connected line + dots over real assistant-message token counts. Real data,
// no estimation. The canvas size stays 100px tall; the window toggle filters
// events client-side to the selected lookback.
let _lastTokenEvents = [];
const TOKEN_WINDOW_DEFAULT = 5;
let _tokenWindowHours = TOKEN_WINDOW_DEFAULT;

function fmtTokensShort(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return Math.round(n / 1_000) + 'k';
  return String(n);
}

// Round up to the next 1/2/5 × 10^n so axis ticks land on nice numbers.
function niceCeil(n) {
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const rel = n / pow;
  let mul;
  if      (rel <= 1) mul = 1;
  else if (rel <= 2) mul = 2;
  else if (rel <= 5) mul = 5;
  else               mul = 10;
  return mul * pow;
}

// Tick positions on the X axis for a given window in hours.
function xAxisTicks(windowHours) {
  if (windowHours <= 1)   return [{ hoursAgo: 1,   label: '1h ago' }, { hoursAgo: 0.5, label: '30m' }, { hoursAgo: 0, label: 'now' }];
  if (windowHours <= 5)   return [{ hoursAgo: 5,   label: '5h ago' }, { hoursAgo: 3,   label: '3h' }, { hoursAgo: 1, label: '1h' }, { hoursAgo: 0, label: 'now' }];
  if (windowHours <= 12)  return [{ hoursAgo: 12,  label: '12h ago' }, { hoursAgo: 8, label: '8h' }, { hoursAgo: 4, label: '4h' }, { hoursAgo: 0, label: 'now' }];
  return                         [{ hoursAgo: 24,  label: '24h ago' }, { hoursAgo: 16, label: '16h' }, { hoursAgo: 8, label: '8h' }, { hoursAgo: 0, label: 'now' }];
}

// Window comes from the user's chip toggle, not the incoming message — the
// extension always sends 24h of events; we filter client-side.
function renderTokenActivity(events) {
  if (events) _lastTokenEvents = events;

  const canvas  = document.getElementById('token-activity-canvas');
  const empty   = document.getElementById('token-activity-empty');
  const totalEl = document.getElementById('token-activity-total');
  const rangeEl = document.getElementById('token-activity-range');
  if (!canvas) return;

  if (rangeEl) rangeEl.textContent = 'last ' + _tokenWindowHours + 'h';

  const now  = Date.now();
  const tMin = now - _tokenWindowHours * 60 * 60 * 1000;
  const visible = _lastTokenEvents.filter(e => e.ts >= tMin);

  // Always draw the canvas so the baseline stays visible even during idle
  // stretches. The "no messages" message only shows as extra context below.
  canvas.style.display = 'block';
  if (empty) empty.style.display = visible.length === 0 ? '' : 'none';

  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 400;
  const cssH = 100;
  if (canvas.width  !== cssW * dpr) canvas.width  = cssW * dpr;
  if (canvas.height !== cssH * dpr) canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Extra padding on the left for the rotated "Tokens" axis name, and at the
  // bottom for the "Time" axis name under the tick labels.
  const padL = 40, padR = 4, padT = 6, padB = 24;
  const w = cssW - padL - padR;
  const h = cssH - padT - padB;

  const tSpan = Math.max(1, now - tMin);
  const xAt = (ts) => padL + ((ts - tMin) / tSpan) * w;

  // Bucketize: count how many bars we want for this window, then sum tokens
  // per bucket. Each bar = total tokens spent during that time slice.
  const WINDOW_BUCKETS = { 1: 12, 5: 30, 12: 24, 24: 24 };
  const numBuckets = WINDOW_BUCKETS[_tokenWindowHours] || 24;
  const windowMs  = _tokenWindowHours * 60 * 60 * 1000;
  const bucketMs  = windowMs / numBuckets;

  const buckets = new Array(numBuckets).fill(0);
  let totalTokens = 0;
  for (const e of visible) {
    const idx = Math.min(numBuckets - 1, Math.max(0, Math.floor((e.ts - tMin) / bucketMs)));
    buckets[idx] += e.tokens;
    totalTokens += e.tokens;
  }

  let maxBucket = 0;
  for (const v of buckets) if (v > maxBucket) maxBucket = v;
  const niceMax = niceCeil(maxBucket) || 1;
  const yAt = (tok) => padT + (1 - Math.max(0, tok) / niceMax) * h;

  // The body gets the .dark class only in dark mode; the default (no class)
  // is light mode, so `contains('dark')` is the only correct check.
  const isDark = document.body.classList.contains('dark');
  const gridColor  = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.18)';
  const labelColor = (getComputedStyle(document.body).getPropertyValue('--text-muted') || '#6e7681').trim();

  // Horizontal grid + Y-axis labels (tokens)
  ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = labelColor;
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const tok  = niceMax * (1 - frac);  // top → max, bottom → 0
    const y    = padT + frac * h;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(padL + w, y + 0.5);
    ctx.stroke();
    const label = fmtTokensShort(tok);
    const lw = ctx.measureText(label).width;
    ctx.fillText(label, padL - lw - 3, y);
  }

  // Vertical grid + X-axis labels (time)
  const ticks = xAxisTicks(_tokenWindowHours);
  ctx.textBaseline = 'alphabetic';
  for (const t of ticks) {
    const ts = now - t.hoursAgo * 60 * 60 * 1000;
    const x = xAt(ts);
    ctx.strokeStyle = gridColor;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, padT);
    ctx.lineTo(x + 0.5, padT + h);
    ctx.stroke();

    const tw = ctx.measureText(t.label).width;
    let lx = x - tw / 2;
    if (lx < padL)            lx = padL;
    if (lx + tw > padL + w)   lx = padL + w - tw;
    ctx.fillStyle = labelColor;
    ctx.fillText(t.label, lx, padT + h + 11);
  }

  // Chart-wide vertical gradient: green at baseline, yellow at ~75%, red only
  // at the very top. Each bar is filled with this single gradient, so short
  // bars stay green and only tall ones reach warm colors.
  const barGrad = ctx.createLinearGradient(0, padT + h, 0, padT);
  barGrad.addColorStop(0.00, '#047857'); // green at baseline
  barGrad.addColorStop(0.50, '#16a34a'); // still green at mid
  barGrad.addColorStop(0.75, '#eab308'); // yellow kicks in around 75%
  barGrad.addColorStop(0.92, '#f59e0b'); // orange nearer the top
  barGrad.addColorStop(1.00, '#ef4444'); // red right at the peak

  const slotW = w / numBuckets;
  const barGap = Math.max(1, slotW * 0.15);
  const barW = Math.max(1, slotW - barGap);
  for (let i = 0; i < numBuckets; i++) {
    const v = buckets[i];
    if (v <= 0) continue;
    const barH = (v / niceMax) * h;
    const x = padL + i * slotW + barGap / 2;
    ctx.fillStyle = barGrad;
    ctx.fillRect(x, padT + h - barH, barW, barH);
  }

  // Axis names — rotated "Tokens" on the Y edge, "Time" under the X edge.
  ctx.fillStyle = labelColor;
  ctx.font = '9px ui-monospace, SFMono-Regular, monospace';

  ctx.save();
  ctx.translate(8, padT + h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText('Tokens', 0, 0);
  ctx.restore();

  ctx.textBaseline = 'alphabetic';
  const timeLabel = 'Time';
  const tlw = ctx.measureText(timeLabel).width;
  ctx.fillText(timeLabel, padL + w / 2 - tlw / 2, cssH - 2);

  if (totalEl) {
    totalEl.textContent = fmtTokensShort(totalTokens) + ' tokens \u00b7 ' + visible.length + ' msgs';
  }
}

window.addEventListener('resize', () => {
  if (_lastTokenEvents.length > 0) renderTokenActivity();
});

function refreshTokenActivity() {
  vscodeApi.postMessage({ type: 'refreshTokenActivity' });
}

// Window-toggle chips: 1h / 5h / 12h / 24h. Selection persists via setState.
(function initTokenWindowChips() {
  const saved = vscodeApi.getState && vscodeApi.getState();
  if (saved && typeof saved.tokenActivityWindow === 'number') {
    _tokenWindowHours = saved.tokenActivityWindow;
  }
  const row = document.getElementById('token-window-filter');
  if (!row) return;
  row.querySelectorAll('.token-window-btn').forEach(btn => {
    const hours = parseInt(btn.dataset.window, 10);
    btn.dataset.active = String(hours === _tokenWindowHours);
    btn.addEventListener('click', () => {
      _tokenWindowHours = hours;
      row.querySelectorAll('.token-window-btn').forEach(b => b.dataset.active = String(parseInt(b.dataset.window, 10) === hours));
      const prev = (vscodeApi.getState && vscodeApi.getState()) || {};
      vscodeApi.setState({ ...prev, tokenActivityWindow: hours });
      renderTokenActivity();
    });
  });
})();

// ─── Dark mode ─────────────────────────────────────────────────────────────
function applyDarkMode(on) {
  document.body.classList.toggle('dark', on);
  const btn = document.getElementById('dark-toggle');
  if (btn) btn.dataset.on = String(on);
}

document.getElementById('dark-toggle').addEventListener('click', () => {
  const isOn = document.body.classList.toggle('dark');
  document.getElementById('dark-toggle').dataset.on = String(isOn);
  vscodeApi.postMessage({ type: 'setDarkMode', value: isOn });
});


// new-session-btn click is handled inline via onclick

// ─── Robot Sprite Animation ────────────────────────────────────────────────
const ROBOT_URI = (window as unknown as { __ROBOT_URI__: string }).__ROBOT_URI__;
const FRAME_W = 48;
const FRAME_H = 48;

// Sprite sheet rows (alphabetical: Crouching 0-10, Standing 11-21)
// Frame counts verified against actual sprite sheet content
const ANIMS = {
  crouchAttack:      { row: 0,  frames: 5 },
  crouchHurt:        { row: 1,  frames: 5 },
  crouchIdle:        { row: 2,  frames: 5 },
  crouchIdleCarry:   { row: 3,  frames: 5 },
  crouchInteract:    { row: 4,  frames: 3 },
  crouchJump:        { row: 5,  frames: 3 },
  crouchLand:        { row: 6,  frames: 5 },
  crouchRun:         { row: 7,  frames: 5 },
  crouchRunCarry:    { row: 8,  frames: 5 },
  crouchWalk:        { row: 9,  frames: 4 },
  crouchWalkCarry:   { row: 10, frames: 4 },
  standAttack:       { row: 11, frames: 5 },
  standHurt:         { row: 12, frames: 5 },
  standIdle:         { row: 13, frames: 5 },
  standIdleCarry:    { row: 14, frames: 5 },
  standInteract:     { row: 15, frames: 3 },
  standJump:         { row: 16, frames: 3 },
  standLand:         { row: 17, frames: 5 },
  standRun:          { row: 18, frames: 5 },
  standRunCarry:     { row: 19, frames: 5 },
  standWalk:         { row: 20, frames: 4 },
  standWalkCarry:    { row: 21, frames: 4 },
};

// Map session state + lastAction to animation
function pickAnim(activity, lastAction) {
  const act = (lastAction || '').toLowerCase();

  // Non-tooling states
  if (activity === 'sleeping')  return 'crouchIdle';
  if (activity === 'thinking')  return 'standIdleCarry';
  if (activity === 'user_sent') return 'standIdleCarry';
  if (activity === 'idle')      return 'standIdle';
  if (activity === 'responding') return 'crouchInteract';

  // Tooling — each tool gets its own animation
  if (activity === 'tooling') {
    // Destructive → electrocution/hurt!
    if (/\b(rm |delet|remov|clean|drop|destroy|unlink)/.test(act)) return 'standHurt';
    // Edit → standing attack (striking changes)
    if (act.startsWith('editing'))   return 'standAttack';
    // Write → crouching attack (creating new)
    if (act.startsWith('writing'))   return 'crouchAttack';
    // Read → standing interact (inspecting)
    if (act.startsWith('reading'))   return 'standInteract';
    // Bash → standing run (running commands)
    if (act.startsWith('running'))   return 'standRun';
    // Grep → standing walk (searching)
    if (act.startsWith('searching')) return 'standWalk';
    // Glob → crouching walk (finding files low)
    if (act.startsWith('finding'))   return 'crouchWalk';
    // Agent → standing run carrying (delegating)
    if (act.startsWith('delegat') || act.includes('agent')) return 'standRunCarry';
    // TodoWrite → crouching idle carry (organizing)
    if (act.includes('todo'))        return 'crouchIdleCarry';
    // WebSearch → standing jump (leaping to web)
    if (act.includes('web search'))  return 'standJump';
    // WebFetch → crouching jump (fetching from web)
    if (act.includes('fetch'))       return 'crouchJump';
    // Commit/push → crouching run (rushing to commit)
    if (act.includes('commit') || act.includes('push')) return 'crouchRun';
    // Notebook → crouching walk carry
    if (act.includes('notebook'))    return 'crouchWalkCarry';
    // Install/build → crouching run carry (heavy lifting)
    if (act.includes('install') || act.includes('build') || act.includes('npm')) return 'crouchRunCarry';
    // Error/fail → crouching hurt
    if (act.includes('error') || act.includes('fail')) return 'crouchHurt';
    // Landing/done → standing land
    if (act.includes('complet') || act.includes('success')) return 'standLand';
    // Save/download → crouching land
    if (act.includes('save') || act.includes('download') || act.includes('export')) return 'crouchLand';
    // Default tooling → standing walk carry
    return 'standWalkCarry';
  }

  return 'standIdle';
}

// Per-session animation state: sessionId -> { anim, frame }
const _animStates = {};
let _robotImg = null;
let _robotReady = false;
let _lastSpriteTime = 0;
const SPRITE_INTERVAL = 143; // ~7 FPS sprite cycling

// Draw a specific session's robot frame on its canvas
function drawRobotForSession(canvas, sessionId) {
  if (!canvas || !_robotReady || !_robotImg) return;
  const state = _animStates[sessionId] || { anim: 'standIdle', frame: 0 };
  const ctx = canvas.getContext('2d');
  const anim = ANIMS[state.anim] || ANIMS.standIdle;
  const frame = state.frame % anim.frames;
  const sx = frame * FRAME_W;
  const sy = anim.row * FRAME_H;

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, FRAME_W, FRAME_H);
  ctx.drawImage(_robotImg, sx, sy, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
}

// 30 FPS render loop; sprite frames advance at ~7 FPS
function renderLoop(ts) {
  if (_robotReady) {
    const advance = ts - _lastSpriteTime >= SPRITE_INTERVAL;
    if (advance) _lastSpriteTime = ts;

    const canvases = document.querySelectorAll('canvas.robot-canvas[data-session-id]');
    canvases.forEach(canvas => {
      const sid = canvas.dataset.sessionId;
      if (advance && _animStates[sid]) {
        _animStates[sid].frame++;
      }
      drawRobotForSession(canvas, sid);
    });

    // Robot status bar canvas
    const barCanvas = document.getElementById('robot-bar-canvas');
    if (barCanvas && _animStates['__bar']) {
      if (advance) _animStates['__bar'].frame++;
      drawRobotForSession(barCanvas, '__bar');
    }
  }
  requestAnimationFrame(renderLoop);
}

// Load sprite sheet — only start animation AFTER image is ready
(function loadRobotSprite() {
  _robotImg = new Image();
  _robotImg.onload = () => {
    _robotReady = true;
    requestAnimationFrame(renderLoop);
  };
  _robotImg.src = ROBOT_URI;
})();

// Update all per-card animations from session data
function updateAllAnimations(sessions) {
  for (const s of sessions) {
    const newAnim = pickAnim(s.activity, s.lastAction);
    const existing = _animStates[s.sessionId];
    if (!existing || existing.anim !== newAnim) {
      _animStates[s.sessionId] = { anim: newAnim, frame: 0 };
    }
  }
}

// ─── Skills search & filter ─────────────────────────────────────────────────
// Fixed display order matches SKILL_CATEGORIES in src/session/categorize.ts.
const SKILL_CATEGORY_ORDER = [
  'Planning', 'Design', 'Review', 'Testing',
  'SEO & Content', 'Automation', 'Integrations', 'Dev Tools', 'Other',
];

let _allSkills = [];
let _skillFilter = 'all';
let _skillCategory = 'all';
let _categoryChipsReady = false;

function ensureCategoryChips() {
  if (_categoryChipsReady) return;
  const row = document.getElementById('skills-category-filter');
  if (!row) return;
  const presentCategories = new Set(_allSkills.map(s => s.category).filter(Boolean));
  const shown = SKILL_CATEGORY_ORDER.filter(c => presentCategories.has(c));
  if (shown.length === 0) return;
  const allBtn = '<button class="skills-category-btn" data-category="all" data-active="true">All</button>';
  row.innerHTML = allBtn + shown.map(c =>
    '<button class="skills-category-btn" data-category="' + c + '" data-active="false">' + c + '</button>'
  ).join('');
  row.querySelectorAll('.skills-category-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      row.querySelectorAll('.skills-category-btn').forEach(b => b.dataset.active = 'false');
      btn.dataset.active = 'true';
      _skillCategory = btn.dataset.category;
      renderSkills();
    });
  });
  _categoryChipsReady = true;
}

function renderSkills() {
  ensureCategoryChips();
  const list = document.getElementById('skills-list');
  if (!list) return;

  const query = (document.getElementById('skills-search') || {}).value || '';
  const q = query.toLowerCase();
  const filtered = _allSkills.filter(s => {
    if (_skillFilter !== 'all' && s.source !== _skillFilter) return false;
    if (_skillCategory !== 'all' && s.category !== _skillCategory) return false;
    if (q && !s.name.toLowerCase().includes(q) && !(s.description || '').toLowerCase().includes(q)) return false;
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="cap-item" style="color:#a0a0a0;">No skills match</div>';
    return;
  }

  list.innerHTML = filtered.map(s => {
    const badge = s.source === 'user'
      ? '<span class="skill-badge skill-badge-user">USER</span>'
      : '<span class="skill-badge skill-badge-plugin">PLUGIN</span>';
    const desc = s.description
      ? '<div class="skill-desc">' + s.description + '</div>'
      : '';
    return '<div class="skill-item" data-source="' + s.source + '" onclick="vscodeApi.postMessage({type:\'inputSkill\',name:\'/' + s.name + '\'})"><div><span class="skill-name">/' + s.name + '</span>' + badge + '</div>' + desc + '</div>';
  }).join('');
}

document.getElementById('skills-search').addEventListener('input', renderSkills);

document.querySelectorAll('.skills-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.skills-filter-btn').forEach(b => b.dataset.active = 'false');
    btn.dataset.active = 'true';
    _skillFilter = btn.dataset.filter;
    renderSkills();
  });
});

// ─── CLI Tools ──────────────────────────────────────────────────────────────
function renderClis(clis) {
  const list = document.getElementById('cli-list');
  if (!list) return;
  if (!clis || clis.length === 0) {
    list.innerHTML = '<div class="cap-item" style="color:#a0a0a0;">No CLIs detected</div>';
    return;
  }

  const groups = {};
  const order = [];
  for (const c of clis) {
    if (!groups[c.group]) { groups[c.group] = []; order.push(c.group); }
    groups[c.group].push(c);
  }

  const html = order.map(group => {
    const items = groups[group].map(c => {
      const status = c.installed ? 'connected' : 'no';
      const color = c.installed ? '' : 'color:var(--text-muted);';
      if (c.installed) {
        return '<div class="cap-item" style="cursor:pointer;" onclick="vscodeApi.postMessage({type:\'inputSkill\',name:\'' + c.name + '\'})"><span class="cap-dot" data-status="' + status + '"></span><span>' + c.name + '</span></div>';
      }
      return '<div class="cap-item" style="' + color + '"><span class="cap-dot" data-status="' + status + '"></span><span>' + c.name + '</span></div>';
    }).join('');
    return '<div class="cli-group-label">' + group + '</div>' + items;
  }).join('');

  list.innerHTML = html;
}

// ─── Section collapse & drag-to-reorder ─────────────────────────────────────
function toggleSection(header) {
  const open = header.dataset.open !== 'false';
  header.dataset.open = open ? 'false' : 'true';
  saveLayoutState();
}

function togglePin(pinEl) {
  const section = pinEl.closest('.section');
  const root = document.getElementById('root');
  const pinned = pinEl.dataset.pinned !== 'true';
  pinEl.dataset.pinned = String(pinned);
  section.dataset.pinned = String(pinned);

  // Move section: after sticky-top + all pinned sections
  const allSections = [...root.querySelectorAll('.section[draggable]')];
  const lastPinned = allSections.filter(s => s.dataset.pinned === 'true' && s !== section).pop();
  const stickyTop = document.getElementById('sticky-top');
  const insertAfter = lastPinned || stickyTop;
  if (insertAfter && insertAfter.nextSibling) {
    root.insertBefore(section, insertAfter.nextSibling);
  }

  recalcPinOffsets();
  saveLayoutState();
}

function recalcPinOffsets() {
  const stickyTop = document.getElementById('sticky-top');
  let offset = stickyTop ? stickyTop.offsetHeight : 0;
  const sections = document.querySelectorAll('#root > .section[draggable]');
  sections.forEach(s => {
    if (s.dataset.pinned === 'true') {
      s.style.top = offset + 'px';
      offset += s.offsetHeight;
    } else {
      s.style.top = '';
    }
  });
}

function saveLayoutState() {
  const sections = document.querySelectorAll('#root > .section[draggable]');
  const order = [];
  const collapsed = {};
  const pinned = {};
  sections.forEach(s => {
    order.push(s.id);
    const h = s.querySelector('.section-header');
    if (h && h.dataset.open === 'false') collapsed[s.id] = true;
    if (s.dataset.pinned === 'true') pinned[s.id] = true;
  });
  vscodeApi.setState({ sectionOrder: order, sectionCollapsed: collapsed, sectionPinned: pinned });
}

// On first load (no saved state), collapse every section except Sessions, Usage, and Token Activity.
const DEFAULT_OPEN = new Set(['sessions-section', 'usage-section', 'token-activity-section']);

function applyDefaultCollapse() {
  document.querySelectorAll('#root > .section[draggable]').forEach(s => {
    if (!DEFAULT_OPEN.has(s.id)) {
      const h = s.querySelector('.section-header');
      if (h) h.dataset.open = 'false';
    }
  });
}

function restoreLayoutState() {
  const state = vscodeApi.getState();
  if (!state) { applyDefaultCollapse(); return; }
  const root = document.getElementById('root');
  if (state.sectionOrder) {
    const sections = {};
    root.querySelectorAll('.section[draggable]').forEach(s => { sections[s.id] = s; });
    for (const id of state.sectionOrder) {
      if (sections[id]) root.appendChild(sections[id]);
    }
  }
  if (state.sectionCollapsed) {
    for (const [id, val] of Object.entries(state.sectionCollapsed)) {
      if (!val) continue;
      const el = document.getElementById(id);
      if (el) {
        const h = el.querySelector('.section-header');
        if (h) h.dataset.open = 'false';
      }
    }
  }
  if (state.sectionPinned) {
    for (const [id, val] of Object.entries(state.sectionPinned)) {
      if (!val) continue;
      const el = document.getElementById(id);
      if (el) {
        el.dataset.pinned = 'true';
        const pin = el.querySelector('.section-pin');
        if (pin) pin.dataset.pinned = 'true';
      }
    }
    recalcPinOffsets();
  }
}

// Drag to reorder
let _draggedSection = null;
document.querySelectorAll('.section[draggable]').forEach(section => {
  section.addEventListener('dragstart', e => {
    _draggedSection = section;
    section.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  section.addEventListener('dragend', () => {
    section.classList.remove('dragging');
    document.querySelectorAll('.section.drag-over').forEach(s => s.classList.remove('drag-over'));
    _draggedSection = null;
    saveLayoutState();
  });
  section.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (section !== _draggedSection) {
      document.querySelectorAll('.section.drag-over').forEach(s => s.classList.remove('drag-over'));
      section.classList.add('drag-over');
    }
  });
  section.addEventListener('dragleave', () => {
    section.classList.remove('drag-over');
  });
  section.addEventListener('drop', e => {
    e.preventDefault();
    section.classList.remove('drag-over');
    if (_draggedSection && _draggedSection !== section) {
      const root = document.getElementById('root');
      const allSections = [...root.querySelectorAll('.section[draggable]')];
      const dragIdx = allSections.indexOf(_draggedSection);
      const dropIdx = allSections.indexOf(section);
      if (dragIdx < dropIdx) {
        section.after(_draggedSection);
      } else {
        section.before(_draggedSection);
      }
    }
  });
});

restoreLayoutState();

// ─── Boot ───────────────────────────────────────────────────────────────────
vscodeApi.postMessage({ type: 'ready' });

// Expose the things that inline HTML onclick handlers reference.
(window as any).vscodeApi             = vscodeApi;
(window as any).toggleSection         = toggleSection;
(window as any).togglePin             = togglePin;
(window as any).refreshUsage          = refreshUsage;
(window as any).refreshTokenActivity  = refreshTokenActivity;
