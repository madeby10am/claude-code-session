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
