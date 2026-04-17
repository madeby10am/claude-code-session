import { describe, it, expect } from 'vitest';
import {
  toProjectName,
  extractLastField,
  defaultSession,
  humanizeToolUse,
  parseLines,
} from '../src/session/jsonlParser';
import { SessionEntry } from '../src/session/types';

function newEntry(sessionId = 'abc123'): SessionEntry {
  return {
    state: defaultSession(sessionId, '-Users-niko-repo', 0),
    fileOffset: 0,
    filePath: '/tmp/fake.jsonl',
    idleTimer: null,
    sleepTimer: null,
  };
}

describe('toProjectName', () => {
  it('takes the last 3 slug segments and title-cases them', () => {
    expect(toProjectName('-Users-niko-Documents-Anthropic-Claude-claude-code-session'))
      .toBe('Claude Code Session');
  });

  it('handles short slugs', () => {
    expect(toProjectName('my-app')).toBe('My App');
  });
});

describe('humanizeToolUse', () => {
  it('formats Read with the basename', () => {
    expect(humanizeToolUse('Read', { file_path: '/a/b/c.ts' })).toBe('Reading c.ts');
  });

  it('truncates long Bash commands', () => {
    const cmd = 'x'.repeat(100);
    const out = humanizeToolUse('Bash', { command: cmd });
    expect(out.startsWith('Running ')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
  });

  it('falls back to the tool name for unknown tools', () => {
    expect(humanizeToolUse('UnknownTool', {})).toBe('UnknownTool');
  });
});

describe('extractLastField', () => {
  it('returns the field from the last matching line', () => {
    const content = [
      '{"type":"ai-title","aiTitle":"first"}',
      '{"type":"user","content":"hi"}',
      '{"type":"ai-title","aiTitle":"second"}',
    ].join('\n');
    expect(extractLastField(content, '"ai-title"', 'aiTitle')).toBe('second');
  });

  it('returns undefined when the marker is missing', () => {
    expect(extractLastField('{}', '"missing"', 'x')).toBeUndefined();
  });
});

describe('parseLines', () => {
  it('applies a user message and transitions activity to user_sent', () => {
    const entry = newEntry();
    const line = JSON.stringify({
      type: 'user',
      timestamp: Date.now(),
      message: { content: 'hello' },
    });
    const changed = parseLines(line, entry);
    expect(changed).toBe(true);
    expect(entry.state.activity).toBe('user_sent');
    expect(entry.state.turnCount).toBe(1);
  });

  it('applies an assistant end_turn and records tokens + model', () => {
    const entry = newEntry();
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: Date.now(),
      message: {
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done.' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    const changed = parseLines(line, entry);
    expect(changed).toBe(true);
    expect(entry.state.activity).toBe('responding');
    expect(entry.state.model).toBe('claude-sonnet-4-6');
    expect(entry.state.outputTokens).toBe(50);
  });

  it('detects questions and sets needsInput', () => {
    const entry = newEntry();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Which option do you prefer?' }],
      },
    });
    parseLines(line, entry);
    expect(entry.state.needsInput).toBe(true);
  });

  it('re-keys via callback when sessionId changes', () => {
    const entry = newEntry('old-id');
    let captured: [string, string] | null = null;
    const line = JSON.stringify({
      type: 'user',
      sessionId: 'new-id',
      message: { content: 'hi' },
    });
    parseLines(line, entry, (oldId, newId) => { captured = [oldId, newId]; });
    expect(entry.state.sessionId).toBe('new-id');
    expect(captured).toEqual(['old-id', 'new-id']);
  });

  it('increments toolUseCount for tool_use blocks', () => {
    const entry = newEntry();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/b.ts' } },
        ],
      },
    });
    parseLines(line, entry);
    expect(entry.state.toolUseCount).toBe(2);
    expect(entry.state.activity).toBe('tooling');
    expect(entry.state.lastAction).toBe('Editing b.ts');
  });
});
