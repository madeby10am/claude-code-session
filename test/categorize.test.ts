import { describe, it, expect } from 'vitest';
import { categorizeSkill } from '../src/session/categorize';

describe('categorizeSkill', () => {
  it('routes explicit code-review skills to Review', () => {
    expect(categorizeSkill('code-review', 'Review a PR')).toBe('Review');
  });

  it('routes brainstorming/plan skills to Planning', () => {
    expect(categorizeSkill('brainstorm', 'Explore ideas')).toBe('Planning');
    expect(categorizeSkill('writing-plans', 'Create an implementation plan')).toBe('Planning');
  });

  it('routes frontend-design to Design', () => {
    expect(categorizeSkill('frontend-design', 'Build UI mockups')).toBe('Design');
  });

  it('routes TDD/debug to Testing', () => {
    expect(categorizeSkill('test-driven-development', 'write tests first')).toBe('Testing');
    expect(categorizeSkill('systematic-debugging', 'debug bugs')).toBe('Testing');
  });

  it('routes geo/seo content skills to SEO & Content', () => {
    expect(categorizeSkill('geo-audit', 'GEO full audit')).toBe('SEO & Content');
    expect(categorizeSkill('geo-schema', 'Schema markup')).toBe('SEO & Content');
  });

  it('routes n8n / playwright to Automation', () => {
    expect(categorizeSkill('n8n-code-javascript', 'write n8n js')).toBe('Automation');
    expect(categorizeSkill('playwright-cli', 'browser automation')).toBe('Automation');
  });

  it('routes stripe / api / mcp to Integrations', () => {
    expect(categorizeSkill('stripe:explain-error', 'Stripe API errors')).toBe('Integrations');
    expect(categorizeSkill('claude-api', 'Anthropic SDK')).toBe('Integrations');
  });

  it('routes config/keybindings to Dev Tools', () => {
    expect(categorizeSkill('update-config', 'Configure settings.json')).toBe('Dev Tools');
    expect(categorizeSkill('keybindings-help', 'Custom keyboard shortcuts')).toBe('Dev Tools');
  });

  it('falls back to Other for unrecognized', () => {
    expect(categorizeSkill('foo-bar', 'does something weird')).toBe('Other');
  });

  it('is case-insensitive', () => {
    expect(categorizeSkill('SEO-FOO', 'Capital letters')).toBe('SEO & Content');
  });
});
