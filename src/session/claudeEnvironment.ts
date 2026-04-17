import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

export const CLAUDE_DIR            = path.join(os.homedir(), '.claude');
export const CLAUDE_PROJECTS_DIR   = path.join(CLAUDE_DIR, 'projects');
export const CLAUDE_SETTINGS_PATH  = path.join(CLAUDE_DIR, 'settings.json');

export interface SkillInfo {
  name:        string;
  source:      string;
  description: string;
}

function parseSkillDescription(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/description:\s*>?\s*\n?\s*(.+?)(?:\n\S|\n---)/s);
    if (match) {
      return match[1].replace(/\n\s*/g, ' ').trim().slice(0, 120);
    }
    const singleLine = content.match(/description:\s*["']?(.+?)["']?\s*$/m);
    if (singleLine) {
      return singleLine[1].trim().slice(0, 120);
    }
  } catch { /* ignore */ }
  return '';
}

export function getMcpServers(): string[] {
  const servers: string[] = [];
  try {
    const globalMcp = path.join(CLAUDE_DIR, 'mcp.json');
    if (fs.existsSync(globalMcp)) {
      const data = JSON.parse(fs.readFileSync(globalMcp, 'utf-8'));
      if (data.mcpServers) {
        servers.push(...Object.keys(data.mcpServers));
      }
    }
  } catch { /* ignore */ }
  return servers;
}

export function getSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();

  try {
    const userSkillsDir = path.join(CLAUDE_DIR, 'skills');
    if (fs.existsSync(userSkillsDir)) {
      for (const name of fs.readdirSync(userSkillsDir)) {
        const skillFile = path.join(userSkillsDir, name, 'SKILL.md');
        if (fs.existsSync(skillFile) && !seen.has(name)) {
          seen.add(name);
          skills.push({ name, source: 'user', description: parseSkillDescription(skillFile) });
        }
      }
    }
  } catch { /* ignore */ }

  try {
    const cacheDir = path.join(CLAUDE_DIR, 'plugins', 'cache');
    if (fs.existsSync(cacheDir)) {
      for (const vendor of fs.readdirSync(cacheDir)) {
        const vendorDir = path.join(cacheDir, vendor);
        try {
          if (!fs.statSync(vendorDir).isDirectory()) { continue; }
          for (const plugin of fs.readdirSync(vendorDir)) {
            const pluginDir = path.join(vendorDir, plugin);
            try {
              if (!fs.statSync(pluginDir).isDirectory()) { continue; }
              const candidates = [path.join(pluginDir, 'skills')];
              for (const version of fs.readdirSync(pluginDir)) {
                candidates.push(path.join(pluginDir, version, 'skills'));
              }
              for (const skillsDir of candidates) {
                try {
                  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) { continue; }
                  for (const name of fs.readdirSync(skillsDir)) {
                    const sf = path.join(skillsDir, name, 'SKILL.md');
                    if (!seen.has(name) && fs.existsSync(sf)) {
                      seen.add(name);
                      skills.push({ name, source: 'plugin', description: parseSkillDescription(sf) });
                    }
                  }
                } catch { /* ignore */ }
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
