# Pixel Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VS Code extension that shows an animated 64×64 pixel art "Classic Dev" character in a pinned split editor panel, with six animation states driven by VS Code editor activity and Claude Code log file watching.

**Architecture:** The extension host wires four focused modules — `StateManager` (state machine + timers), `ActivityMonitor` (VS Code keypress events), `ClaudeWatcher` (fs.watch on Claude logs), and `Panel` (WebviewPanel lifecycle). On state transitions, `Panel.setState()` sends a `postMessage` to the webview. The webview swaps a `data-state` attribute; inline CSS `steps()` animations drive sprite sheet frame stepping. Webview HTML/CSS/JS is built as a template string inside `buildHtml()` to correctly resolve webview URIs for sprite sheet images.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode`), `canvas` npm package (sprite generation), Vitest (unit tests), inline HTML/CSS/vanilla JS (webview)

---

## File Map

| File | Responsibility |
|---|---|
| `package.json` | Extension manifest + scripts |
| `tsconfig.json` | Compiler config for `src/` |
| `tsconfig.scripts.json` | Compiler config for `scripts/` |
| `vitest.config.ts` | Test runner config with vscode module alias |
| `src/extension.ts` | Activation entrypoint, wires all modules, `deactivate()` |
| `src/stateManager.ts` | State machine with 6 states, internal timers, transition logic |
| `src/activityMonitor.ts` | `onDidChangeTextDocument` listener → `StateManager.onKeypress()` |
| `src/claudeWatcher.ts` | `fs.watch` on Claude log dir → `StateManager.onClaudeActive/Idle()` |
| `src/panel.ts` | `WebviewPanel` create/dispose, `setState()` postMessage, `buildHtml()` |
| `assets/sprites/typing.png` | 4-frame horizontal sprite strip |
| `assets/sprites/drinking.png` | 6-frame horizontal sprite strip |
| `assets/sprites/leaning.png` | 3-frame horizontal sprite strip |
| `assets/sprites/stretching.png` | 6-frame horizontal sprite strip |
| `assets/sprites/walking.png` | 6-frame horizontal sprite strip |
| `assets/sprites/sleeping.png` | 2-frame horizontal sprite strip |
| `scripts/generate-sprites.ts` | One-time node-canvas generator for all sprite sheets |
| `test/__mocks__/vscode.ts` | Minimal VS Code API mock for Vitest |
| `test/stateManager.test.ts` | Unit tests for state machine |
| `test/activityMonitor.test.ts` | Unit tests for activity monitor |
| `test/claudeWatcher.test.ts` | Unit tests for Claude watcher |

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.scripts.json`
- Create: `vitest.config.ts`
- Create: `.vscodeignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pixel-agent",
  "displayName": "Pixel Agent",
  "description": "A pixel art developer companion that reacts to your coding activity",
  "version": "0.0.1",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "activationEvents": ["*"],
  "main": "./out/extension.js",
  "contributes": {},
  "scripts": {
    "vscode:prepublish": "npm run compile",
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "generate-sprites": "ts-node --project tsconfig.scripts.json scripts/generate-sprites.ts",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.85.0",
    "canvas": "^2.11.2",
    "ts-node": "^10.9.0",
    "typescript": "^5.3.0",
    "vitest": "^1.2.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "outDir": "out",
    "lib": ["ES2020"],
    "sourceMap": true,
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "out", "scripts", "test"]
}
```

- [ ] **Step 3: Create `tsconfig.scripts.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "out-scripts"
  },
  "include": ["scripts"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    alias: {
      vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
  },
});
```

- [ ] **Step 5: Create `.vscodeignore`**

```
.vscode/**
node_modules/**
src/**
test/**
scripts/**
out-scripts/**
**/*.ts
**/*.map
tsconfig*.json
vitest.config.ts
.gitignore
```

- [ ] **Step 6: Create directory structure**

```bash
mkdir -p src assets/sprites scripts test/__mocks__
```

- [ ] **Step 7: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created with no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json tsconfig.scripts.json vitest.config.ts .vscodeignore
git commit -m "feat: scaffold pixel-agent VS Code extension"
```

---

## Task 2: Sprite Sheet Generator

**Files:**
- Create: `scripts/generate-sprites.ts`
- Generates: `assets/sprites/*.png`

One-time build script. No TDD — verified by running it and inspecting output.

- [ ] **Step 1: Create `scripts/generate-sprites.ts`**

```typescript
import { createCanvas, Canvas, CanvasRenderingContext2D } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';

const W = 64;
const H = 64;
const OUT = path.join(__dirname, '../assets/sprites');

// ── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg:        '#0d0d1a',
  skin:      '#f4c27f',
  hair:      '#5c3a1e',
  shirt:     '#555568',
  pants:     '#2a3a5c',
  shoes:     '#1a1a1a',
  glasses:   '#333333',
  desk:      '#7a5535',
  deskEdge:  '#5a3e28',
  monitor:   '#222222',
  screen:    '#00c4ff',
  screenHi:  '#66ddff',
  kbd:       '#2a2a2a',
  kbdKey:    '#404040',
  mug:       '#cc3333',
  mugLight:  '#dd5544',
  zzz:       '#9999ee',
  mouth:     '#c27a50',
  pupil:     '#222222',
  chairSeat: '#333344',
  floor:     '#0a0a18',
  shadow:    '#1a1a2e',
};

// ── Primitives ───────────────────────────────────────────────────────────────
function r(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// ── Scene components ─────────────────────────────────────────────────────────
function drawBg(ctx: CanvasRenderingContext2D) {
  r(ctx, 0, 0, W, H, C.bg);
  r(ctx, 0, 50, W, H - 50, C.floor);
}

function drawDesk(ctx: CanvasRenderingContext2D) {
  r(ctx, 0, 44, W, 2, C.deskEdge);
  r(ctx, 0, 46, W, 18, C.desk);
}

function drawMonitor(ctx: CanvasRenderingContext2D) {
  r(ctx, 4, 26, 28, 20, C.monitor);     // body
  r(ctx, 6, 28, 24, 16, C.screen);      // screen
  r(ctx, 7, 29, 5,  2,  C.screenHi);   // highlight
  r(ctx, 16, 46, 4,  2,  '#444444');    // stand
  r(ctx, 13, 48, 10, 1,  '#555555');    // base
}

function drawKeyboard(ctx: CanvasRenderingContext2D) {
  r(ctx, 6, 47, 26, 4, C.kbd);
  for (let i = 0; i < 6; i++) {
    r(ctx, 7 + i * 4, 48, 3, 1, C.kbdKey);
    r(ctx, 7 + i * 4, 50, 3, 1, C.kbdKey);
  }
}

function drawChair(ctx: CanvasRenderingContext2D, recline = 0) {
  r(ctx, 30, 42 + recline, 24, 3, C.chairSeat);
  if (recline > 0) {
    r(ctx, 51, 30 + recline, 3, 12 - recline, '#2a2a3a');
  }
}

// ── Character parts ──────────────────────────────────────────────────────────
function drawHead(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  // Hair
  r(ctx, cx - 8, cy,     16, 6, C.hair);
  r(ctx, cx - 8, cy + 2, 2,  8, C.hair);  // left side
  r(ctx, cx + 7, cy + 2, 2,  6, C.hair);  // right side
  // Face
  r(ctx, cx - 6, cy + 2, 13, 10, C.skin);
  // Glasses
  r(ctx, cx - 5, cy + 5, 4, 3, C.glasses);
  r(ctx, cx + 2, cy + 5, 4, 3, C.glasses);
  r(ctx, cx - 1, cy + 5, 3, 1, C.glasses);  // bridge
  // Pupils
  ctx.fillStyle = C.pupil;
  ctx.fillRect(cx - 4, cy + 6, 2, 2);
  ctx.fillRect(cx + 3, cy + 6, 2, 2);
  // Mouth
  r(ctx, cx - 2, cy + 9, 5, 1, C.mouth);
  // Neck
  r(ctx, cx - 2, cy + 12, 4, 2, C.skin);
}

function drawTorso(ctx: CanvasRenderingContext2D, cx: number, cy: number, tiltX = 0) {
  r(ctx, cx - 10 + tiltX, cy, 20, 12, C.shirt);
}

function drawPants(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  r(ctx, cx - 10, cy, 9, 8, C.pants);
  r(ctx, cx + 2,  cy, 9, 8, C.pants);
  r(ctx, cx,      cy, 1, 8, '#1a2a44');  // crease
}

function drawArms(
  ctx: CanvasRenderingContext2D,
  cx: number, bodyY: number,
  lHandX: number, lHandY: number,
  rHandX: number, rHandY: number,
  tiltX = 0
) {
  // Upper arm stubs
  r(ctx, cx - 12 + tiltX, bodyY + 2, 3, 8, C.shirt);
  r(ctx, cx +  8 + tiltX, bodyY + 2, 3, 8, C.shirt);
  // Forearms
  const lArmTop = bodyY + 8;
  const rArmTop = bodyY + 8;
  if (lHandY > lArmTop) r(ctx, lHandX - 1, lArmTop, 3, lHandY - lArmTop, C.skin);
  if (rHandY > rArmTop) r(ctx, rHandX - 1, rArmTop, 3, rHandY - rArmTop, C.skin);
  // Hands
  r(ctx, lHandX - 2, lHandY, 5, 3, C.skin);
  r(ctx, rHandX - 2, rHandY, 5, 3, C.skin);
}

// Shared defaults for seated desk pose
const CX   = 38;   // character center X
const HY   = 10;   // head top Y
const BY   = 22;   // torso top Y
const LHX  = 14;   // left hand default X
const RHX  = 46;   // right hand default X
const KY   = 47;   // keyboard Y (hands rest here)

// ── Frame generators ─────────────────────────────────────────────────────────
function framesTyping(): Canvas[] {
  // 4 frames: hands alternate up/down over keyboard
  const offsets = [
    { l: 0, r: 0 },
    { l: -2, r: 0 },
    { l: 0, r: 0 },
    { l: 0, r: -2 },
  ];
  return offsets.map(({ l, r }) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    drawBg(ctx); drawMonitor(ctx); drawDesk(ctx); drawKeyboard(ctx); drawChair(ctx);
    drawHead(ctx, CX, HY);
    drawTorso(ctx, CX, BY);
    drawPants(ctx, CX, BY + 12);
    drawArms(ctx, CX, BY, LHX, KY + l, RHX, KY + r);
    return c;
  });
}

function framesDrinking(): Canvas[] {
  // 6 frames: right arm raises mug to mouth then back
  const mugPath = [
    { mx: 52, my: 47, ry: KY     },  // mug on desk
    { mx: 50, my: 44, ry: KY - 3 },  // reaching
    { mx: 48, my: 40, ry: KY - 7 },  // lifting
    { mx: 44, my: 34, ry: KY - 13 }, // at mouth
    { mx: 44, my: 34, ry: KY - 13 }, // sipping
    { mx: 50, my: 42, ry: KY - 5 },  // lowering
  ];
  return mugPath.map(({ mx, my, ry }) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    drawBg(ctx); drawMonitor(ctx); drawDesk(ctx); drawKeyboard(ctx); drawChair(ctx);
    drawHead(ctx, CX, HY);
    drawTorso(ctx, CX, BY);
    drawPants(ctx, CX, BY + 12);
    drawArms(ctx, CX, BY, LHX, KY, RHX, ry);
    // Mug
    r(ctx, mx, my, 6, 5, C.mug);
    r(ctx, mx + 1, my, 4, 2, C.mugLight);
    r(ctx, mx + 6, my + 1, 2, 3, C.mug);  // handle
    return c;
  });
}

function framesLeaning(): Canvas[] {
  // 3 frames: gradually recline, arms behind head on frame 3
  const poses = [
    { recline: 0, tilt: 0,  lhx: LHX, lhy: KY,      rhx: RHX, rhy: KY      },
    { recline: 2, tilt: 2,  lhx: LHX, lhy: KY,      rhx: RHX, rhy: KY      },
    { recline: 4, tilt: 4,  lhx: CX - 14, lhy: BY + 2, rhx: CX + 14, rhy: BY + 2 },
  ];
  return poses.map(({ recline, tilt, lhx, lhy, rhx, rhy }) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    drawBg(ctx); drawMonitor(ctx); drawDesk(ctx); drawKeyboard(ctx); drawChair(ctx, recline);
    drawHead(ctx, CX, HY + recline);
    drawTorso(ctx, CX, BY + recline, tilt);
    drawPants(ctx, CX, BY + recline + 12);
    drawArms(ctx, CX, BY + recline, lhx, lhy + recline, rhx, rhy + recline, tilt);
    return c;
  });
}

function framesStretching(): Canvas[] {
  // 6 frames: arms rise above head then lower
  const armYs = [KY, 38, 28, 18, 18, 28];
  const armSpreads = [0, 2, 5, 8, 8, 5];
  return armYs.map((ay, i) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    drawBg(ctx); drawMonitor(ctx); drawDesk(ctx); drawKeyboard(ctx); drawChair(ctx);
    drawHead(ctx, CX, HY);
    drawTorso(ctx, CX, BY);
    drawPants(ctx, CX, BY + 12);
    drawArms(ctx, CX, BY, LHX - armSpreads[i], ay, RHX + armSpreads[i], ay);
    return c;
  });
}

function framesWalking(): Canvas[] {
  // 6 frames: walk cycle, no desk (character strides in front of dark bg)
  const frames = [
    { ll: [-4, 0, 8], rl: [4, 6, 14], la: -3, ra: 3 },   // left forward
    { ll: [-2, 0, 11], rl: [2, 3, 11], la: -1, ra: 1 },   // neutral
    { ll: [4, 6, 14], rl: [-4, 0, 8], la: 3, ra: -3 },    // right forward
    { ll: [2, 3, 11], rl: [-2, 0, 11], la: 1, ra: -1 },   // neutral
    { ll: [-4, 0, 8], rl: [4, 6, 14], la: -3, ra: 3 },    // left forward (loop)
    { ll: [-2, 0, 11], rl: [2, 3, 11], la: -1, ra: 1 },   // neutral
  ];
  // ll = [xOffset, topOffset, bottomY], la = arm swing X offset
  const baseY = 44;
  const wx = 32;  // walker center X
  return frames.map(({ ll, rl, la, ra }) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    r(ctx, 0, 0, W, H, C.bg);
    r(ctx, 0, 54, W, 10, C.floor);
    r(ctx, 0, 54, W, 1, '#2a2a4a');
    // Legs
    r(ctx, wx + ll[0] - 3, baseY + ll[1], 5, ll[2] - ll[1], C.pants);
    r(ctx, wx + rl[0] - 2, baseY + rl[1], 5, rl[2] - rl[1], C.pants);
    // Shoes
    r(ctx, wx + ll[0] - 5, baseY + ll[2], 7, 2, C.shoes);
    r(ctx, wx + rl[0] - 2, baseY + rl[2], 7, 2, C.shoes);
    // Torso
    r(ctx, wx - 9, baseY - 14, 18, 12, C.shirt);
    // Arms
    r(ctx, wx - 11 + la, baseY - 12, 3, 9, C.shirt);
    r(ctx, wx +  9 + ra, baseY - 12, 3, 9, C.shirt);
    r(ctx, wx - 13 + la, baseY -  4, 5, 3, C.skin);
    r(ctx, wx +  9 + ra, baseY -  4, 5, 3, C.skin);
    // Head
    drawHead(ctx, wx + 2, baseY - 28);
    return c;
  });
}

function framesSleeping(): Canvas[] {
  // 2 frames: head drooped, ZZZ pulses
  return [0, 1].map((i) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    drawBg(ctx); drawMonitor(ctx); drawDesk(ctx); drawKeyboard(ctx); drawChair(ctx);
    const droop = 4 + i * 2;
    drawHead(ctx, CX, HY + droop);
    drawTorso(ctx, CX, BY);
    drawPants(ctx, CX, BY + 12);
    // Arms resting on desk
    r(ctx, LHX - 2, KY, 5, 3, C.skin);
    r(ctx, RHX - 2, KY, 5, 3, C.skin);
    r(ctx, LHX - 1, BY + 8, 3, KY - BY - 8, C.skin);
    r(ctx, RHX - 1, BY + 8, 3, KY - BY - 8, C.skin);
    // Z's
    const zx = CX + 10;
    const zy = HY - 2 - i * 3;
    // Small Z
    r(ctx, zx, zy, 5, 1, C.zzz);
    r(ctx, zx, zy + 1, 1, 3, C.zzz);
    r(ctx, zx + 4, zy + 1, 1, 3, C.zzz);
    r(ctx, zx, zy + 4, 5, 1, C.zzz);
    if (i === 1) {
      // Big Z offset above
      const bx = zx + 6; const by = zy - 5;
      r(ctx, bx, by, 7, 1, C.zzz);
      r(ctx, bx, by + 1, 1, 5, C.zzz);
      r(ctx, bx + 6, by + 1, 1, 5, C.zzz);
      r(ctx, bx, by + 6, 7, 1, C.zzz);
    }
    return c;
  });
}

// ── Assemble & save ───────────────────────────────────────────────────────────
function saveSheet(name: string, frames: Canvas[]) {
  const sheet = createCanvas(W * frames.length, H);
  const ctx = sheet.getContext('2d');
  for (let i = 0; i < frames.length; i++) {
    ctx.drawImage(frames[i], i * W, 0);
  }
  const buf = sheet.toBuffer('image/png');
  fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
  console.log(`✓ ${name}.png  (${frames.length} frames, ${W * frames.length}×${H}px)`);
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  saveSheet('typing',     framesTyping());
  saveSheet('drinking',   framesDrinking());
  saveSheet('leaning',    framesLeaning());
  saveSheet('stretching', framesStretching());
  saveSheet('walking',    framesWalking());
  saveSheet('sleeping',   framesSleeping());
  console.log('\nAll sprite sheets generated.');
}

main();
```

- [ ] **Step 2: Run the generator**

```bash
npm run generate-sprites
```

Expected output:
```
✓ typing.png      (4 frames, 256×64px)
✓ drinking.png    (6 frames, 384×64px)
✓ leaning.png     (3 frames, 192×64px)
✓ stretching.png  (6 frames, 384×64px)
✓ walking.png     (6 frames, 384×64px)
✓ sleeping.png    (2 frames, 128×64px)

All sprite sheets generated.
```

Verify: `ls assets/sprites/` should list 6 `.png` files.

- [ ] **Step 3: Commit**

```bash
git add scripts/generate-sprites.ts assets/sprites/
git commit -m "feat: add sprite sheet generator and generated assets"
```

---

## Task 3: StateManager (TDD)

**Files:**
- Create: `test/__mocks__/vscode.ts`
- Create: `test/stateManager.test.ts`
- Create: `src/stateManager.ts`

- [ ] **Step 1: Create `test/__mocks__/vscode.ts`**

```typescript
import { vi } from 'vitest';

export const workspace = {
  onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
};

export const window = {
  createWebviewPanel: vi.fn(),
  onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
};

export const Uri = {
  joinPath: vi.fn((_base: unknown, ...parts: string[]) => ({ path: parts.join('/') })),
};

export enum ViewColumn { Two = 2 }
```

- [ ] **Step 2: Write failing tests in `test/stateManager.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateManager, AnimationState } from '../src/stateManager';

describe('StateManager', () => {
  let sm: StateManager;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onChange = vi.fn();
    sm = new StateManager(onChange);
  });

  afterEach(() => {
    sm.dispose();
    vi.useRealTimers();
  });

  it('starts in typing state', () => {
    expect(sm.getCurrent()).toBe('typing');
  });

  it('transitions to drinking_coffee after 30s idle', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);
    expect(sm.getCurrent()).toBe('drinking_coffee');
    expect(onChange).toHaveBeenCalledWith('drinking_coffee');
  });

  it('transitions to leaning_back when drinking animation ends', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);        // → drinking_coffee
    sm.onAnimationDone();                   // → leaning_back
    expect(sm.getCurrent()).toBe('leaning_back');
  });

  it('transitions to walking after 5min in leaning_back', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);
    sm.onAnimationDone();                   // → leaning_back
    vi.advanceTimersByTime(5 * 60_000);
    expect(sm.getCurrent()).toBe('walking');
  });

  it('transitions to sleeping after 10min in walking', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);
    sm.onAnimationDone();
    vi.advanceTimersByTime(5 * 60_000);     // → walking
    vi.advanceTimersByTime(10 * 60_000);    // → sleeping
    expect(sm.getCurrent()).toBe('sleeping');
  });

  it('any keypress snaps back to typing from any state', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);
    sm.onAnimationDone();                   // → leaning_back
    sm.onKeypress();
    expect(sm.getCurrent()).toBe('typing');
  });

  it('keypress resets the 30s idle timer', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(25_000);
    sm.onKeypress();                        // reset
    vi.advanceTimersByTime(25_000);         // only 25s since last press
    expect(sm.getCurrent()).toBe('typing');
    vi.advanceTimersByTime(5_000);          // now 30s
    expect(sm.getCurrent()).toBe('drinking_coffee');
  });

  it('transitions to stretching after 15min continuous typing', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(15 * 60_000);
    expect(sm.getCurrent()).toBe('stretching');
  });

  it('returns to typing after stretching animation ends', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(15 * 60_000);    // → stretching
    sm.onAnimationDone();                   // → typing
    expect(sm.getCurrent()).toBe('typing');
  });

  it('claude active overrides walking with leaning_back', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(30_000);
    sm.onAnimationDone();
    vi.advanceTimersByTime(5 * 60_000);     // → walking
    sm.onClaudeActive();
    expect(sm.getCurrent()).toBe('leaning_back');
  });

  it('claude active does NOT override typing', () => {
    sm.onKeypress();
    sm.onClaudeActive();
    expect(sm.getCurrent()).toBe('typing');
  });

  it('claude active does NOT override stretching', () => {
    sm.onKeypress();
    vi.advanceTimersByTime(15 * 60_000);    // → stretching
    sm.onClaudeActive();
    expect(sm.getCurrent()).toBe('stretching');
  });

  it('does not fire onChange when state is unchanged', () => {
    sm.onKeypress();
    sm.onKeypress();
    expect(onChange).not.toHaveBeenCalled(); // already typing, no change
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

```bash
npm test
```

Expected: All 13 tests FAIL with `Cannot find module '../src/stateManager'`.

- [ ] **Step 4: Create `src/stateManager.ts`**

```typescript
export type AnimationState =
  | 'typing'
  | 'drinking_coffee'
  | 'leaning_back'
  | 'stretching'
  | 'walking'
  | 'sleeping';

const IDLE_30S     =  30_000;
const IDLE_5MIN    =   5 * 60_000;
const IDLE_10MIN   =  10 * 60_000;
const TYPING_15MIN =  15 * 60_000;

export class StateManager {
  private current: AnimationState = 'typing';
  private idleTimer:     ReturnType<typeof setTimeout> | null = null;
  private longIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer:   ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onStateChange: (state: AnimationState) => void) {}

  getCurrent(): AnimationState {
    return this.current;
  }

  onKeypress(): void {
    this.clearTimers();
    this.transitionTo('typing');
    this.startIdleChain();
    this.startTypingTimer();
  }

  onAnimationDone(): void {
    if (this.current === 'drinking_coffee') {
      this.transitionTo('leaning_back');
      this.startLongIdleChain();
    } else if (this.current === 'stretching') {
      this.transitionTo('typing');
      this.startIdleChain();
      this.startTypingTimer();
    }
  }

  onClaudeActive(): void {
    if (this.current !== 'typing' && this.current !== 'stretching') {
      this.transitionTo('leaning_back');
    }
  }

  onClaudeIdle(): void {
    // No transition — idle chain already running from previous state
  }

  dispose(): void {
    this.clearTimers();
  }

  private transitionTo(next: AnimationState): void {
    if (next === this.current) return;
    this.current = next;
    this.onStateChange(next);
  }

  private startIdleChain(): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.transitionTo('drinking_coffee');
      // leaning_back triggered by onAnimationDone after drink completes
    }, IDLE_30S);
  }

  private startLongIdleChain(): void {
    this.longIdleTimer = setTimeout(() => {
      this.transitionTo('walking');
      this.longIdleTimer = setTimeout(() => {
        this.transitionTo('sleeping');
        this.longIdleTimer = null;
      }, IDLE_10MIN);
    }, IDLE_5MIN);
  }

  private startTypingTimer(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => {
      this.typingTimer = null;
      if (this.current === 'typing') {
        this.transitionTo('stretching');
      }
    }, TYPING_15MIN);
  }

  private clearTimers(): void {
    if (this.idleTimer)     { clearTimeout(this.idleTimer);     this.idleTimer     = null; }
    if (this.longIdleTimer) { clearTimeout(this.longIdleTimer); this.longIdleTimer = null; }
    if (this.typingTimer)   { clearTimeout(this.typingTimer);   this.typingTimer   = null; }
  }
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
npm test
```

Expected: All 13 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/stateManager.ts test/stateManager.test.ts test/__mocks__/vscode.ts
git commit -m "feat: add StateManager with full test coverage"
```

---

## Task 4: ActivityMonitor (TDD)

**Files:**
- Create: `test/activityMonitor.test.ts`
- Create: `src/activityMonitor.ts`

- [ ] **Step 1: Write failing tests in `test/activityMonitor.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityMonitor } from '../src/activityMonitor';
import { StateManager } from '../src/stateManager';

vi.mock('vscode', () => ({
  workspace: {
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

describe('ActivityMonitor', () => {
  let sm: StateManager;
  let monitor: ActivityMonitor;
  let capturedCb: (() => void) | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    const vscode = await import('vscode');
    vi.mocked(vscode.workspace.onDidChangeTextDocument).mockImplementation((cb) => {
      capturedCb = cb as () => void;
      return { dispose: vi.fn() };
    });
    sm = new StateManager(vi.fn());
    monitor = new ActivityMonitor(sm);
  });

  afterEach(() => {
    monitor.dispose();
    sm.dispose();
    vi.useRealTimers();
  });

  it('calls sm.onKeypress when a text document changes', () => {
    const spy = vi.spyOn(sm, 'onKeypress');
    capturedCb!();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('calls sm.onKeypress for each document change event', () => {
    const spy = vi.spyOn(sm, 'onKeypress');
    capturedCb!();
    capturedCb!();
    capturedCb!();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('disposes the VS Code subscription on dispose()', async () => {
    const disposeSpy = vi.fn();
    const vscode = await import('vscode');
    vi.mocked(vscode.workspace.onDidChangeTextDocument).mockReturnValueOnce({
      dispose: disposeSpy,
    });
    const m2 = new ActivityMonitor(sm);
    m2.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- activityMonitor
```

Expected: FAIL with `Cannot find module '../src/activityMonitor'`.

- [ ] **Step 3: Create `src/activityMonitor.ts`**

```typescript
import * as vscode from 'vscode';
import { StateManager } from './stateManager';

export class ActivityMonitor {
  private readonly subscription: vscode.Disposable;

  constructor(stateManager: StateManager) {
    this.subscription = vscode.workspace.onDidChangeTextDocument(() => {
      stateManager.onKeypress();
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm test -- activityMonitor
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/activityMonitor.ts test/activityMonitor.test.ts
git commit -m "feat: add ActivityMonitor with VS Code text document listener"
```

---

## Task 5: ClaudeWatcher (TDD)

**Files:**
- Create: `test/claudeWatcher.test.ts`
- Create: `src/claudeWatcher.ts`

- [ ] **Step 1: Write failing tests in `test/claudeWatcher.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { ClaudeWatcher } from '../src/claudeWatcher';
import { StateManager } from '../src/stateManager';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, watch: vi.fn(), existsSync: vi.fn() };
});

describe('ClaudeWatcher', () => {
  let sm: StateManager;
  let watcher: ClaudeWatcher;
  let capturedCb: (() => void) | null = null;
  const mockClose = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.watch).mockImplementation((_path, cb) => {
      capturedCb = cb as () => void;
      return { close: mockClose } as unknown as fs.FSWatcher;
    });
    sm = new StateManager(vi.fn());
    watcher = new ClaudeWatcher(sm);
  });

  afterEach(() => {
    watcher.dispose();
    sm.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('calls sm.onClaudeActive when log dir changes', () => {
    const spy = vi.spyOn(sm, 'onClaudeActive');
    capturedCb!();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('calls sm.onClaudeIdle 3s after the last file change', () => {
    const idleSpy = vi.spyOn(sm, 'onClaudeIdle');
    capturedCb!();
    capturedCb!();
    capturedCb!();
    expect(idleSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(idleSpy).toHaveBeenCalledTimes(1);
  });

  it('resets the debounce timer on each change', () => {
    const idleSpy = vi.spyOn(sm, 'onClaudeIdle');
    capturedCb!();
    vi.advanceTimersByTime(2_000);
    capturedCb!();                          // reset
    vi.advanceTimersByTime(2_000);          // only 2s since last change
    expect(idleSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);          // now 3s
    expect(idleSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the watcher handle on dispose()', () => {
    watcher.dispose();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('does not throw if Claude log directory does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(() => new ClaudeWatcher(sm)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- claudeWatcher
```

Expected: FAIL with `Cannot find module '../src/claudeWatcher'`.

- [ ] **Step 3: Create `src/claudeWatcher.ts`**

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateManager } from './stateManager';

const LOG_DIR     = path.join(os.homedir(), '.config', 'claude', 'logs');
const DEBOUNCE_MS = 3_000;

export class ClaudeWatcher {
  private watcher:       fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly stateManager: StateManager) {
    if (!fs.existsSync(LOG_DIR)) return;

    this.watcher = fs.watch(LOG_DIR, () => {
      this.stateManager.onClaudeActive();
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.stateManager.onClaudeIdle();
      }, DEBOUNCE_MS);
    });
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
  }
}
```

- [ ] **Step 4: Run full suite — verify all pass**

```bash
npm test
```

Expected: All 21 tests PASS (13 StateManager + 3 ActivityMonitor + 5 ClaudeWatcher).

- [ ] **Step 5: Commit**

```bash
git add src/claudeWatcher.ts test/claudeWatcher.test.ts
git commit -m "feat: add ClaudeWatcher with debounced log file monitoring"
```

---

## Task 6: Panel

**Files:**
- Create: `src/panel.ts`

No unit tests — `Panel` depends entirely on the VS Code `WebviewPanel` API. Verified by running the extension manually in Step 8.

- [ ] **Step 1: Create `src/panel.ts`**

The webview HTML/CSS/JS is inlined in `buildHtml()` so that sprite sheet URIs can be resolved via `webview.asWebviewUri()` at runtime. `onClose` is called when the user closes the panel so the extension can reopen it.

```typescript
import * as vscode from 'vscode';
import { AnimationState } from './stateManager';

export class Panel {
  private static instance: Panel | undefined;
  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onAnimationDone: (state: AnimationState) => void,
    private readonly onClose: () => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'pixelAgent',
      '🧑‍💻 Dev',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'assets'),
        ],
      }
    );

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage((msg: { type: string; state: string }) => {
      if (msg.type === 'animationDone') {
        this.onAnimationDone(msg.state as AnimationState);
      }
    });

    this.panel.onDidDispose(() => {
      Panel.instance = undefined;
      this.onClose();
    });
  }

  static create(
    context: vscode.ExtensionContext,
    onAnimationDone: (state: AnimationState) => void,
    onClose: () => void
  ): Panel {
    if (!Panel.instance) {
      Panel.instance = new Panel(context, onAnimationDone, onClose);
    }
    return Panel.instance;
  }

  static getInstance(): Panel | undefined {
    return Panel.instance;
  }

  setState(state: AnimationState): void {
    this.panel.webview.postMessage({ type: 'setState', state });
  }

  dispose(): void {
    this.panel.dispose();
    Panel.instance = undefined;
  }

  private uri(rel: string): string {
    return this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, rel))
      .toString();
  }

  private buildHtml(): string {
    const t  = this.uri('assets/sprites/typing.png');
    const d  = this.uri('assets/sprites/drinking.png');
    const lb = this.uri('assets/sprites/leaning.png');
    const st = this.uri('assets/sprites/stretching.png');
    const w  = this.uri('assets/sprites/walking.png');
    const sl = this.uri('assets/sprites/sleeping.png');
    const csp = this.panel.webview.cspSource;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${csp} data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:200px; height:200px; overflow:hidden;
  background:#0d0d1a;
  display:flex; align-items:flex-end; justify-content:center;
  padding-bottom:12px;
}
#c {
  width:64px; height:64px;
  image-rendering:pixelated;
  background-repeat:no-repeat;
  background-size:auto 64px;
}
[data-state="typing"] #c {
  background-image:url('${t}');
  animation:at 0.5s steps(4) infinite;
}
@keyframes at { from{background-position:0 0} to{background-position:-256px 0} }

[data-state="drinking_coffee"] #c {
  background-image:url('${d}');
  animation:ad 1.5s steps(6) 1 forwards;
}
@keyframes ad { from{background-position:0 0} to{background-position:-384px 0} }

[data-state="leaning_back"] #c {
  background-image:url('${lb}');
  animation:al 1.5s steps(3) infinite;
}
@keyframes al { from{background-position:0 0} to{background-position:-192px 0} }

[data-state="stretching"] #c {
  background-image:url('${st}');
  animation:as 2s steps(6) 1 forwards;
}
@keyframes as { from{background-position:0 0} to{background-position:-384px 0} }

[data-state="walking"] #c {
  background-image:url('${w}');
  animation:aw 0.75s steps(6) infinite;
}
@keyframes aw { from{background-position:0 0} to{background-position:-384px 0} }

[data-state="sleeping"] #c {
  background-image:url('${sl}');
  animation:asl 4s steps(2) infinite;
}
@keyframes asl { from{background-position:0 0} to{background-position:-128px 0} }
</style>
</head>
<body data-state="typing">
<div id="c"></div>
<script>
const vscode = acquireVsCodeApi();
const el = document.getElementById('c');
window.addEventListener('message', e => {
  if (e.data.type === 'setState') {
    document.body.setAttribute('data-state', e.data.state);
  }
});
el.addEventListener('animationend', () => {
  const s = document.body.getAttribute('data-state');
  if (s === 'drinking_coffee' || s === 'stretching') {
    vscode.postMessage({ type: 'animationDone', state: s });
  }
});
</script>
</body>
</html>`;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/panel.ts
git commit -m "feat: add Panel with inline webview and sprite animation"
```

---

## Task 7: Extension Entrypoint

**Files:**
- Create: `src/extension.ts`

- [ ] **Step 1: Create `src/extension.ts`**

```typescript
import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { ActivityMonitor } from './activityMonitor';
import { ClaudeWatcher } from './claudeWatcher';
import { Panel } from './panel';

let stateManager:    StateManager    | undefined;
let activityMonitor: ActivityMonitor | undefined;
let claudeWatcher:   ClaudeWatcher   | undefined;
let panel:           Panel           | undefined;

export function activate(context: vscode.ExtensionContext) {
  stateManager = new StateManager((state) => {
    panel?.setState(state);
  });

  function openPanel() {
    panel = Panel.create(
      context,
      () => stateManager?.onAnimationDone(),
      openPanel  // reopen when user closes it
    );
  }

  openPanel();
  activityMonitor = new ActivityMonitor(stateManager);
  claudeWatcher   = new ClaudeWatcher(stateManager);
}

export function deactivate() {
  panel?.dispose();
  activityMonitor?.dispose();
  claudeWatcher?.dispose();
  stateManager?.dispose();
}
```

- [ ] **Step 2: Compile the extension**

```bash
npm run compile
```

Expected: No TypeScript errors. `out/extension.js` created.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: add extension entrypoint and wire all modules"
```

---

## Task 8: Smoke Test

- [ ] **Step 1: Run all unit tests one final time**

```bash
npm test
```

Expected: All 21 tests PASS.

- [ ] **Step 2: Open the extension in VS Code's Extension Development Host**

Press `F5` in VS Code with the `pixel-agent` folder open (or run via command palette: `Debug: Start Debugging`). A new VS Code window opens with the extension loaded.

Expected:
- A panel titled "🧑‍💻 Dev" opens automatically in Column 2
- The Classic Dev character is visible and animating in `typing` state

- [ ] **Step 3: Verify state transitions manually**

1. Type in any editor file → character should animate in `typing` state
2. Stop typing for 30 seconds → should transition to `drinking_coffee` (arm raises mug)
3. After drink animation completes → should transition to `leaning_back`
4. Leave idle for 5 minutes → should transition to `walking`
5. Leave idle for 10 more minutes → should transition to `sleeping`
6. Type again → should snap back to `typing`

- [ ] **Step 4: Verify Claude watcher (if Claude Code is running)**

Start a Claude Code session in the terminal. While Claude is processing:
- Character should switch to `leaning_back` if not currently typing

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete pixel-agent VS Code extension"
```
