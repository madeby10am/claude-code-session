import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { categorizeSkill, SkillCategory } from './categorize';

export const CLAUDE_DIR            = path.join(os.homedir(), '.claude');
export const CLAUDE_PROJECTS_DIR   = path.join(CLAUDE_DIR, 'projects');
export const CLAUDE_SETTINGS_PATH  = path.join(CLAUDE_DIR, 'settings.json');
export const CLAUDE_CONFIG_PATH    = path.join(os.homedir(), '.claude.json');

/**
 * Claude Code names each folder under ~/.claude/projects after the project's
 * absolute path with every non-alphanumeric character replaced by '-'
 * (e.g. "/Users/niko/My App" → "-Users-niko-My-App").
 */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface SkillInfo {
  name:        string;
  source:      string;
  description: string;
  category:    SkillCategory;
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
  const servers = new Set<string>();
  // Legacy location (~/.claude/mcp.json) and the current one (~/.claude.json).
  for (const file of [path.join(CLAUDE_DIR, 'mcp.json'), CLAUDE_CONFIG_PATH]) {
    try {
      if (!fs.existsSync(file)) { continue; }
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      for (const name of Object.keys(data.mcpServers ?? {})) {
        servers.add(name);
      }
    } catch { /* ignore */ }
  }
  return Array.from(servers);
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
          const description = parseSkillDescription(skillFile);
          skills.push({ name, source: 'user', description, category: categorizeSkill(name, description) });
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
                      const description = parseSkillDescription(sf);
                      skills.push({ name, source: 'plugin', description, category: categorizeSkill(name, description) });
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
