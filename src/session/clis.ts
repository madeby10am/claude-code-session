import * as fs   from 'fs';
import * as path from 'path';

export interface CliInfo {
  name:      string;
  group:     string;
  installed: boolean;
}

// Curated list of common developer CLIs a Claude Code user is likely to touch.
// Order within a group is alphabetical; groups are displayed in this declared order.
const CURATED: { name: string; group: string }[] = [
  // AI / Dev
  { name: 'claude', group: 'AI & Dev' },
  { name: 'cursor', group: 'AI & Dev' },
  { name: 'gh',     group: 'AI & Dev' },
  { name: 'git',    group: 'AI & Dev' },

  // Package managers
  { name: 'npm',    group: 'Packages' },
  { name: 'yarn',   group: 'Packages' },
  { name: 'pnpm',   group: 'Packages' },
  { name: 'bun',    group: 'Packages' },
  { name: 'pip',    group: 'Packages' },
  { name: 'brew',   group: 'Packages' },

  // Cloud / Deploy
  { name: 'vercel',   group: 'Cloud & Deploy' },
  { name: 'netlify',  group: 'Cloud & Deploy' },
  { name: 'aws',      group: 'Cloud & Deploy' },
  { name: 'gcloud',   group: 'Cloud & Deploy' },
  { name: 'heroku',   group: 'Cloud & Deploy' },
  { name: 'fly',      group: 'Cloud & Deploy' },
  { name: 'railway',  group: 'Cloud & Deploy' },
  { name: 'supabase', group: 'Cloud & Deploy' },
  { name: 'firebase', group: 'Cloud & Deploy' },
  { name: 'doctl',    group: 'Cloud & Deploy' },

  // Containers
  { name: 'docker',         group: 'Containers' },
  { name: 'docker-compose', group: 'Containers' },
  { name: 'kubectl',        group: 'Containers' },

  // Services
  { name: 'stripe',     group: 'Services' },
  { name: 'twilio',     group: 'Services' },
  { name: 'sentry-cli', group: 'Services' },
  { name: 'ngrok',      group: 'Services' },

  // Runtimes
  { name: 'node',    group: 'Runtimes' },
  { name: 'python3', group: 'Runtimes' },
  { name: 'deno',    group: 'Runtimes' },
  { name: 'rustc',   group: 'Runtimes' },
  { name: 'go',      group: 'Runtimes' },
];

function isExecutableOnPath(name: string): boolean {
  const pathEnv = process.env.PATH || '';
  const sep     = process.platform === 'win32' ? ';' : ':';
  const exts    = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase())
    : [''];

  for (const dir of pathEnv.split(sep)) {
    if (!dir) { continue; }
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        // eslint-disable-next-line no-bitwise
        fs.accessSync(full, fs.constants.X_OK);
        return true;
      } catch { /* try next */ }
    }
  }
  return false;
}

/** Probe PATH for each curated CLI. Fast — no spawning, just fs.accessSync. */
export function getInstalledClis(): CliInfo[] {
  return CURATED.map(({ name, group }) => ({
    name,
    group,
    installed: isExecutableOnPath(name),
  }));
}
