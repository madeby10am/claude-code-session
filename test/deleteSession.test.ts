import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSessionLog, sessionDataPaths, runningSessionIds, isRunning } from '../src/session/deleteSession';

const ID    = '134dc508-14f7-4f06-bf6b-64db45a71d3e';
const OTHER = '13d35880-0b0c-4635-9325-cdd7c54bd3e8';

let claudeDir: string;
let projectDir: string;

const touch = (p: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{}\n');
};

beforeEach(() => {
  claudeDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-delete-'));
  projectDir = path.join(claudeDir, 'projects', '-home-me-app');
});

afterEach(() => {
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

describe('isSessionLog', () => {
  it('accepts a UUID transcript directly inside a project folder', () => {
    expect(isSessionLog(path.join(projectDir, `${ID}.jsonl`), claudeDir)).toBe(true);
  });

  it.each([
    ['a non-UUID name',        () => path.join(projectDir, 'notes.jsonl')],
    ['a dot-dot name',         () => path.join(projectDir, '...jsonl')],
    ['another extension',      () => path.join(projectDir, `${ID}.json`)],
    ['a session folder',       () => path.join(projectDir, ID)],
    ['a subagent log',         () => path.join(projectDir, ID, 'subagents', `${OTHER}.jsonl`)],
    ['the projects root',      () => path.join(claudeDir, 'projects', `${ID}.jsonl`)],
    ['outside the projects',   () => path.join(claudeDir, 'x', 'y', `${ID}.jsonl`)],
    ['a path escaping upward', () => path.join(claudeDir, 'projects') + `/-home-me-app/../../${ID}.jsonl`],
    ['a slug of dot-dot',      () => path.join(claudeDir, 'projects') + `/../${ID}.jsonl`],
  ])('rejects %s', (_label, make) => {
    expect(isSessionLog(make(), claudeDir)).toBe(false);
  });
});

describe('sessionDataPaths', () => {
  it('collects the transcript first, then everything stored under its id', () => {
    const log = path.join(projectDir, `${ID}.jsonl`);
    touch(log);
    touch(path.join(projectDir, ID, 'subagents', 'agent-1.jsonl'));
    touch(path.join(claudeDir, 'file-history', ID, 'backup@v1'));
    touch(path.join(claudeDir, 'session-env', ID, 'env.sh'));

    expect(sessionDataPaths(log, claudeDir)).toEqual([
      log,
      path.join(projectDir, ID),
      path.join(claudeDir, 'file-history', ID),
      path.join(claudeDir, 'session-env', ID),
    ]);
  });

  it('skips stores this session never used', () => {
    const log = path.join(projectDir, `${ID}.jsonl`);
    touch(log);
    expect(sessionDataPaths(log, claudeDir)).toEqual([log]);
  });

  it("never picks up another session's data", () => {
    const log = path.join(projectDir, `${ID}.jsonl`);
    touch(log);
    touch(path.join(projectDir, `${OTHER}.jsonl`));
    touch(path.join(claudeDir, 'file-history', OTHER, 'backup@v1'));
    expect(sessionDataPaths(log, claudeDir)).toEqual([log]);
  });

  it('returns nothing for a path that is not a session log', () => {
    const notes = path.join(projectDir, 'notes.jsonl');
    touch(notes);
    expect(sessionDataPaths(notes, claudeDir)).toEqual([]);
  });
});

describe('runningSessionIds', () => {
  const register = (file: string, body: string) => {
    fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'sessions', file), body);
  };
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

  it('lists sessions whose process is alive', () => {
    register('1.json', JSON.stringify({ pid: process.pid, sessionId: ID }));
    expect([...runningSessionIds(claudeDir)]).toEqual([ID]);
  });

  it('ignores files left behind by a dead process', () => {
    register('1.json', JSON.stringify({ pid: deadPid(), sessionId: ID }));
    expect(runningSessionIds(claudeDir).size).toBe(0);
  });

  it('survives malformed entries', () => {
    register('bad.json', '{not json');
    register('nopid.json', JSON.stringify({ sessionId: ID }));
    register('zero.json', JSON.stringify({ pid: 0, sessionId: ID }));
    register('other.txt', 'ignored');
    expect(runningSessionIds(claudeDir).size).toBe(0);
  });

  it('is empty when the registry does not exist', () => {
    expect(runningSessionIds(claudeDir).size).toBe(0);
  });
});

describe('isRunning', () => {
  it('matches on the logged sessionId or the file name', () => {
    const file = `/x/${ID}.jsonl`;
    expect(isRunning({ sessionId: ID, filePath: file }, new Set([ID]))).toBe(true);
    expect(isRunning({ sessionId: OTHER, filePath: file }, new Set([ID]))).toBe(true);
    expect(isRunning({ sessionId: OTHER, filePath: `/x/${OTHER}.jsonl` }, new Set([ID]))).toBe(false);
  });
});
