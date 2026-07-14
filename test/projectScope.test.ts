import { describe, it, expect } from 'vitest';
import { encodeProjectPath } from '../src/session/claudeEnvironment';
import { getContextLimit } from '../src/session/types';

describe('encodeProjectPath', () => {
  it('replaces slashes, spaces, and dots with dashes', () => {
    expect(encodeProjectPath('/Users/niko/Documents/Anthropic Claude/claude-code-session'))
      .toBe('-Users-niko-Documents-Anthropic-Claude-claude-code-session');
  });

  it('handles emails and special characters in cloud paths', () => {
    expect(encodeProjectPath('/Users/niko/GoogleDrive-niko@parasynch.com/My Drive'))
      .toBe('-Users-niko-GoogleDrive-niko-parasynch-com-My-Drive');
  });

  it('keeps alphanumerics intact', () => {
    expect(encodeProjectPath('/a/B2/c3')).toBe('-a-B2-c3');
  });
});

describe('getContextLimit', () => {
  it('gives 1M to current-generation models', () => {
    expect(getContextLimit('claude-fable-5')).toBe(1_000_000);
    expect(getContextLimit('claude-opus-4-8')).toBe(1_000_000);
    expect(getContextLimit('claude-sonnet-5')).toBe(1_000_000);
    expect(getContextLimit('claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('gives 200K to Haiku and older Opus/Sonnet', () => {
    expect(getContextLimit('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(getContextLimit('claude-opus-4-5-20251101')).toBe(200_000);
    expect(getContextLimit('claude-3-5-sonnet-20241022')).toBe(200_000);
  });

  it('defaults unknown/empty models to 200K', () => {
    expect(getContextLimit('')).toBe(200_000);
    expect(getContextLimit('some-other-model')).toBe(200_000);
  });
});
