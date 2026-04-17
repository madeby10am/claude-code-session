export type SkillCategory =
  | 'Planning'
  | 'Design'
  | 'Review'
  | 'Testing'
  | 'SEO & Content'
  | 'Automation'
  | 'Integrations'
  | 'Dev Tools'
  | 'Other';

export const SKILL_CATEGORIES: SkillCategory[] = [
  'Planning',
  'Design',
  'Review',
  'Testing',
  'SEO & Content',
  'Automation',
  'Integrations',
  'Dev Tools',
  'Other',
];

// Keyword rules, checked in this order against the lower-cased skill name + description.
// First match wins; anything that matches nothing lands in 'Other'.
const RULES: { category: SkillCategory; keywords: string[] }[] = [
  { category: 'Review',        keywords: ['review', 'refactor', 'code-review', 'security-review', 'receiving-code'] },
  { category: 'Planning',      keywords: ['plan', 'brainstorm', 'spec', 'architect', 'roadmap'] },
  { category: 'Design',        keywords: ['design', 'frontend', 'mockup', 'wireframe', 'ui/ux', 'ux'] },
  { category: 'Testing',       keywords: ['test', 'tdd', 'debug', 'systematic-debug', 'verification'] },
  { category: 'SEO & Content', keywords: ['seo', 'geo', 'content', 'schema', 'llms', 'citability', 'brand-mention', 'e-e-a-t'] },
  { category: 'Automation',    keywords: ['n8n', 'playwright', 'browser', 'workflow', 'scrape', 'cron', 'schedul', 'loop', 'automat'] },
  { category: 'Integrations',  keywords: ['api', 'mcp', 'stripe', 'webhook', 'claude-api', 'notion', 'slack', 'twilio'] },
  { category: 'Dev Tools',     keywords: ['config', 'keybind', 'memory', 'deploy', 'ci', 'cd', 'docker', 'git', 'permission', 'setup', 'init'] },
];

/** Returns the category for a skill based on its name and description. */
export function categorizeSkill(name: string, description: string): SkillCategory {
  const haystack = (name + ' ' + description).toLowerCase();
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (haystack.includes(kw)) {
        return rule.category;
      }
    }
  }
  return 'Other';
}
