import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ID_NEW = '11111111-1111-4111-8111-111111111111';
const ID_OLD = '22222222-2222-4222-8222-222222222222';
const ID_SDK = '33333333-3333-4333-8333-333333333333';
const ID_FAR = '44444444-4444-4444-8444-444444444444';
const ID_REKEY = '55555555-5555-4555-8555-555555555555';
const ID_OTHER = '66666666-6666-4666-8666-666666666666';
const ID_RESUMED = '77777777-7777-4777-8777-777777777777';

const DAY_MS = 24 * 3600 * 1000;

let home: string;
let realHome: string | undefined;
let manager: any;

const line = (o: object) => JSON.stringify(o) + '\n';

function writeLog(slug: string, id: string, body: string, ageMs = 0) {
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, body);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return file;
}

beforeAll(async () => {
  // claudeEnvironment reads the home folder at import time, so redirect it first.
  realHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-saved-'));
  process.env.HOME = home;

  const slug = '-home-me-app';
  writeLog(slug, ID_NEW, line({ type: 'ai-title', aiTitle: 'Newest', sessionId: ID_NEW, entrypoint: 'cli' }));
  writeLog(slug, ID_OLD, line({ type: 'custom-title', customTitle: 'Week old', sessionId: ID_OLD }), 7 * DAY_MS);
  writeLog(slug, ID_SDK, line({ type: 'ai-title', aiTitle: 'Automation', sessionId: ID_SDK, entrypoint: 'sdk-py' }), DAY_MS);
  writeLog(slug, ID_FAR, line({ type: 'ai-title', aiTitle: 'Before a long line', sessionId: ID_FAR })
    + line({ type: 'assistant', message: { content: 'x'.repeat(20_000) } }), 2 * DAY_MS);
  writeLog(slug, ID_REKEY, line({ type: 'ai-title', aiTitle: 'Resumed', sessionId: ID_RESUMED }), 3 * DAY_MS);
  writeLog(`${slug}-packages-web`, ID_OTHER, line({ type: 'ai-title', aiTitle: 'Subfolder', sessionId: ID_OTHER }), 4 * DAY_MS);
  writeLog('-home-me-elsewhere', '88888888-8888-4888-8888-888888888888', line({ type: 'ai-title', aiTitle: 'Other project' }));
  writeLog(slug, 'not-a-session', line({ type: 'ai-title', aiTitle: 'Not a session' }));

  const { SessionManager } = await import('../src/sessionManager');
  manager = new SessionManager(() => {}, ['/home/me/app']);
});

afterAll(() => {
  manager?.dispose();
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('listSavedSessions', () => {
  const titles = () => manager.listSavedSessions().map((s: any) => s.chatTitle);

  it('lists old sessions too, newest first', () => {
    expect(titles()).toEqual(['Newest', 'Before a long line', 'Resumed', 'Subfolder', 'Week old']);
  });

  it('leaves out other projects, SDK sessions and stray files', () => {
    expect(titles()).not.toContain('Other project');
    expect(titles()).not.toContain('Automation');
    expect(titles()).not.toContain('Not a session');
  });

  it('dates a session by its file, not by when it was read', () => {
    const old = manager.listSavedSessions().find((s: any) => s.chatTitle === 'Week old');
    expect(Math.round((Date.now() - old.lastSeen) / DAY_MS)).toBe(7);
  });

  it('keeps the file path when a log reports a different sessionId', () => {
    const resumed = manager.listSavedSessions().find((s: any) => s.chatTitle === 'Resumed');
    expect(resumed.sessionId).toBe(ID_RESUMED);
    expect(path.basename(resumed.filePath)).toBe(`${ID_REKEY}.jsonl`);
  });
});

describe('getSavedSession', () => {
  it('resolves a session tracked live', () => {
    expect(path.basename(manager.getSavedSession(ID_NEW).filePath)).toBe(`${ID_NEW}.jsonl`);
  });

  it('knows nothing about ids it is not tracking', () => {
    expect(manager.getSavedSession('../../etc/passwd')).toBeUndefined();
    expect(manager.getSavedSession(ID_OLD)).toBeUndefined();
  });
});
