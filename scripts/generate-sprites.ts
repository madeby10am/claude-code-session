import { createCanvas, Canvas, CanvasRenderingContext2D } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';

const W = 16, H = 32;
const OUT = path.join(__dirname, '..', 'assets', 'sprites');

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  skin:   '#f0c8a0',
  hair:   '#3d2314',
  shirt:  '#4a90d9',
  pants:  '#2c3e50',
  shoes:  '#1a1a1a',
  desk:   '#c8a882',
  mon:    '#2d2d2d',
  screen: '#00ccff',
  keys:   '#e0e0e0',
  mug:    '#e74c3c',
  zzz:    '#9b59b6',
  mouth:  '#c08060',
  pupil:  '#333333',
  chair:  '#607080',
  white:  '#ffffff',
  shadow: '#00000033',
  deskEdge: '#a08060',
  shirtDark: '#2d6aad',
  skinDark:  '#d4a070',
};

// ── Primitive rect helper ─────────────────────────────────────────────────────
function r(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  w: number, h: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// ── Shared head/face for 16×32 seated character ───────────────────────────────
// headY: top row of hair block
// cx: horizontal center (default 8 for 16-wide canvas)
function drawHead16(ctx: CanvasRenderingContext2D, cx: number, headY: number) {
  // Hair block (rows headY to headY+1, x=4-11)
  r(ctx, cx - 4, headY,     8, 2, C.hair);
  // Face (rows headY+2 to headY+5, x=5-10)
  r(ctx, cx - 3, headY + 2, 6, 4, C.skin);
  // Side hair strands
  r(ctx, cx - 4, headY + 2, 1, 3, C.hair);
  r(ctx, cx + 3, headY + 2, 1, 3, C.hair);
  // Eyes — pupils at row headY+3, 1px each
  r(ctx, cx - 2, headY + 3, 1, 1, C.pupil);
  r(ctx, cx + 1, headY + 3, 1, 1, C.pupil);
  // Mouth at row headY+5, 2px wide
  r(ctx, cx - 1, headY + 5, 2, 1, C.mouth);
}

// Variant: head tilted 1px lower (for char_read frame 1)
function drawHeadTilted(ctx: CanvasRenderingContext2D, cx: number, headY: number) {
  drawHead16(ctx, cx, headY + 1);
}

// ── Shared seated torso (rows 7-13) ──────────────────────────────────────────
function drawTorso16(ctx: CanvasRenderingContext2D) {
  // Collar nub
  r(ctx, 7, 7, 2, 1, C.skin);
  // Shirt body rows 8-13
  r(ctx, 4, 8,  8, 6, C.shirt);
  // Shading on shirt sides for depth
  r(ctx, 4, 8,  1, 6, C.shirtDark);
  r(ctx, 11, 8, 1, 6, C.shirtDark);
}

// ── Desk surface (rows 15-16 for seated sprites) ──────────────────────────────
function drawDesk16(ctx: CanvasRenderingContext2D) {
  r(ctx, 0, 15, 16, 1, C.deskEdge);
  r(ctx, 0, 16, 16, 16, C.desk);
}

// ── Keyboard on desk (rows 17-18) ─────────────────────────────────────────────
function drawKeyboard16(ctx: CanvasRenderingContext2D) {
  r(ctx, 2, 17, 12, 3, C.mon);
  // Key rows
  r(ctx, 3, 18, 10, 1, C.keys);
  // Individual key gaps (tiny dark dots)
  for (let k = 0; k < 4; k++) {
    r(ctx, 3 + k * 2 + 1, 18, 1, 1, '#cccccc');
  }
}

// ── Full seated frame base (no arms) ─────────────────────────────────────────
function drawSeatedBase(ctx: CanvasRenderingContext2D, headY: number) {
  ctx.clearRect(0, 0, W, H);
  drawHead16(ctx, 8, headY);
  drawTorso16(ctx);
  drawDesk16(ctx);
}

// ── Arms helpers ──────────────────────────────────────────────────────────────
// Draw left arm from shoulder (row 12) down to handY, hands at x=2-4
function drawLeftArm(ctx: CanvasRenderingContext2D, handY: number) {
  // Upper arm stub
  r(ctx, 2, 12, 3, 2, C.shirt);
  // Forearm (skin)
  const forearmTop = 14;
  if (handY > forearmTop) {
    r(ctx, 2, forearmTop, 2, handY - forearmTop, C.skin);
  }
  // Hand
  r(ctx, 2, handY, 3, 2, C.skin);
}

function drawRightArm(ctx: CanvasRenderingContext2D, handY: number) {
  // Upper arm stub
  r(ctx, 11, 12, 3, 2, C.shirt);
  // Forearm (skin)
  const forearmTop = 14;
  if (handY > forearmTop) {
    r(ctx, 11, forearmTop, 2, handY - forearmTop, C.skin);
  }
  // Hand
  r(ctx, 11, handY, 3, 2, C.skin);
}

// Draw right arm raised to a given Y (arm goes up from shoulder)
function drawRightArmRaised(ctx: CanvasRenderingContext2D, handY: number, handX: number) {
  // Upper arm — from shoulder (row 12) upward to handY
  const shoulderY = 12;
  if (handY < shoulderY) {
    // Arm goes upward: draw a simple diagonal line via rects
    const dy = shoulderY - handY;
    r(ctx, 11, shoulderY - dy, 2, dy + 2, C.skin);
  } else {
    r(ctx, 11, 12, 2, 2, C.shirt);
    r(ctx, 11, 14, 2, handY - 14, C.skin);
  }
  // Hand at specified position
  r(ctx, handX, handY, 3, 2, C.skin);
}

// ── char_idle.png — 1 frame, 16×32 ───────────────────────────────────────────
function genIdle(): Canvas[] {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  drawHead16(ctx, 8, 1);
  drawTorso16(ctx);
  // Arms resting on desk edge (handY=15)
  drawLeftArm(ctx, 15);
  drawRightArm(ctx, 15);
  drawDesk16(ctx);
  // Hands rest visibly on desk surface (overdraw slightly for polish)
  r(ctx, 2, 15, 3, 2, C.skin);
  r(ctx, 11, 15, 3, 2, C.skin);
  return [c];
}

// ── char_type.png — 2 frames, 32×32 ──────────────────────────────────────────
// Frame 0: hands at row 14 (lower on keys)
// Frame 1: hands at row 13 (raised slightly)
function genType(): Canvas[] {
  return [14, 13].map((handY) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    drawSeatedBase(ctx, 1);
    drawKeyboard16(ctx);
    drawLeftArm(ctx, handY);
    drawRightArm(ctx, handY);
    return c;
  });
}

// ── char_read.png — 2 frames, 32×32 ──────────────────────────────────────────
// Frame 0: head straight, arms resting, monitor visible
// Frame 1: head 1px lower, slight lean forward
function genRead(): Canvas[] {
  // Frame 0 — normal seated with monitor on desk
  const f0 = createCanvas(W, H);
  const ctx0 = f0.getContext('2d');
  ctx0.clearRect(0, 0, W, H);
  drawHead16(ctx0, 8, 1);
  drawTorso16(ctx0);
  drawLeftArm(ctx0, 15);
  drawRightArm(ctx0, 15);
  drawDesk16(ctx0);
  // Small monitor on the desk (rows 16-19, right side)
  r(ctx0, 9, 16, 6, 5, C.mon);
  r(ctx0, 10, 17, 4, 3, C.screen);

  // Frame 1 — head tilted, leaning slightly forward
  const f1 = createCanvas(W, H);
  const ctx1 = f1.getContext('2d');
  ctx1.clearRect(0, 0, W, H);
  // Head at row 2 (1px lower) and drawn via tilt helper
  drawHeadTilted(ctx1, 8, 1);
  // Torso shifted down 1px to match lean
  r(ctx1, 7, 8, 2, 1, C.skin); // collar
  r(ctx1, 4, 9, 8, 6, C.shirt);
  r(ctx1, 4, 9, 1, 6, C.shirtDark);
  r(ctx1, 11, 9, 1, 6, C.shirtDark);
  drawLeftArm(ctx1, 15);
  drawRightArm(ctx1, 15);
  drawDesk16(ctx1);
  r(ctx1, 9, 16, 6, 5, C.mon);
  r(ctx1, 10, 17, 4, 3, C.screen);

  return [f0, f1];
}

// ── Walking character — full body 16×32 ──────────────────────────────────────
// Head rows 1-6, torso 7-15, legs 16-27, feet 28-31
function drawWalkHead(ctx: CanvasRenderingContext2D, cx: number, facing: 'front' | 'back') {
  if (facing === 'front') {
    // Hair
    r(ctx, cx - 4, 1, 8, 2, C.hair);
    r(ctx, cx - 4, 3, 1, 3, C.hair);
    r(ctx, cx + 3, 3, 1, 3, C.hair);
    // Face
    r(ctx, cx - 3, 3, 6, 4, C.skin);
    // Eyes
    r(ctx, cx - 2, 4, 1, 1, C.pupil);
    r(ctx, cx + 1, 4, 1, 1, C.pupil);
    // Mouth
    r(ctx, cx - 1, 6, 2, 1, C.mouth);
  } else {
    // Back of head: all hair
    r(ctx, cx - 4, 1, 8, 6, C.hair);
    // Small hair shading
    r(ctx, cx - 3, 2, 6, 3, '#5a3520');
  }
}

function drawWalkTorso(ctx: CanvasRenderingContext2D) {
  r(ctx, 4, 7,  8, 9, C.shirt);
  r(ctx, 4, 7,  1, 9, C.shirtDark);
  r(ctx, 11, 7, 1, 9, C.shirtDark);
  // Collar
  r(ctx, 7, 7, 2, 1, C.skin);
}

function drawWalkTorsoBack(ctx: CanvasRenderingContext2D) {
  r(ctx, 4, 7,  8, 9, C.shirt);
  r(ctx, 4, 7,  1, 9, C.shirtDark);
  r(ctx, 11, 7, 1, 9, C.shirtDark);
}

// Draw legs: legOffset controls stride spread
// leftX, rightX are center x of each leg
function drawLegs(
  ctx: CanvasRenderingContext2D,
  leftPhase: number,  // -1 back, 0 neutral, 1 forward
  rightPhase: number,
) {
  const legTop = 16;

  // Left leg
  const lx = 5;
  const lLegLen = 10;
  const lFootFwd = leftPhase;
  r(ctx, lx,     legTop,          3, lLegLen, C.pants);
  // Foot
  r(ctx, lx + lFootFwd - 1, legTop + lLegLen, 4, 2, C.shoes);

  // Right leg
  const rx = 9;
  const rLegLen = 10;
  const rFootFwd = rightPhase;
  r(ctx, rx, legTop, 3, rLegLen, C.pants);
  // Foot
  r(ctx, rx + rFootFwd - 1, legTop + rLegLen, 4, 2, C.shoes);
}

// Walk arms swinging
function drawWalkArms(ctx: CanvasRenderingContext2D, leftSwing: number, rightSwing: number) {
  // Left arm (x=2-3)
  r(ctx, 2, 8,  2, 6, C.shirt);
  r(ctx, 2 + leftSwing,  13, 3, 2, C.skin);
  // Right arm (x=11-12)
  r(ctx, 12, 8, 2, 6, C.shirt);
  r(ctx, 11 + rightSwing, 13, 3, 2, C.skin);
}

function drawWalkArmsBack(ctx: CanvasRenderingContext2D, leftSwing: number, rightSwing: number) {
  r(ctx, 2, 8,  2, 6, C.shirt);
  r(ctx, 2 + leftSwing,  13, 3, 2, C.skin);
  r(ctx, 12, 8, 2, 6, C.shirt);
  r(ctx, 11 + rightSwing, 13, 3, 2, C.skin);
}

// ── char_walk_d.png — 4 frames, toward camera ─────────────────────────────────
function genWalkD(): Canvas[] {
  // Frames: neutral, left-forward, neutral, right-forward
  const phases: Array<[number, number, number, number]> = [
    [0, 0, 0, 0],    // neutral
    [-1, 1, 1, -1],  // left leg forward, right arm forward
    [0, 0, 0, 0],    // neutral
    [1, -1, -1, 1],  // right leg forward, left arm forward
  ];
  return phases.map(([lp, rp, la, ra]) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    drawWalkHead(ctx, 8, 'front');
    drawWalkTorso(ctx);
    drawWalkArms(ctx, la, ra);
    drawLegs(ctx, lp, rp);
    return c;
  });
}

// ── char_walk_u.png — 4 frames, away from camera ─────────────────────────────
function genWalkU(): Canvas[] {
  const phases: Array<[number, number, number, number]> = [
    [0, 0, 0, 0],
    [-1, 1, 1, -1],
    [0, 0, 0, 0],
    [1, -1, -1, 1],
  ];
  return phases.map(([lp, rp, la, ra]) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    drawWalkHead(ctx, 8, 'back');
    drawWalkTorsoBack(ctx);
    drawWalkArmsBack(ctx, la, ra);
    drawLegs(ctx, lp, rp);
    return c;
  });
}

// ── char_walk_r.png — 4 frames, side profile right ───────────────────────────
function genWalkR(): Canvas[] {
  // Side view: head faces right (x=8-13), body x=5-12
  // Front leg (leading) at x=8-11, back leg at x=5-8
  // 4 frames: neutral, right-forward, neutral, left-forward
  const legConfigs: Array<{ frontX: number, backX: number, frontY: number, backY: number, armSwing: number }> = [
    { frontX: 7, backX: 6, frontY: 26, backY: 26, armSwing: 0 },
    { frontX: 9, backX: 5, frontY: 26, backY: 26, armSwing: -1 },
    { frontX: 7, backX: 6, frontY: 26, backY: 26, armSwing: 0 },
    { frontX: 5, backX: 9, frontY: 26, backY: 26, armSwing: 1 },
  ];
  return legConfigs.map(({ frontX, backX, frontY, backY, armSwing }) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // --- Head facing right ---
    // Hair (wider on left side as silhouette)
    r(ctx, 5, 1, 7, 2, C.hair);     // top hair
    r(ctx, 5, 3, 2, 3, C.hair);     // back of head
    // Face (right side)
    r(ctx, 7, 3, 5, 4, C.skin);
    // Eye (single, facing right)
    r(ctx, 10, 4, 1, 1, C.pupil);
    // Mouth
    r(ctx, 10, 6, 1, 1, C.mouth);
    // Ear
    r(ctx, 7, 5, 1, 2, C.skinDark);

    // --- Torso side view ---
    r(ctx, 5, 7, 7, 9, C.shirt);
    // Back arm (behind body)
    r(ctx, 4, 8, 2, 6, C.shirtDark);
    r(ctx, 4 - armSwing, 13, 3, 2, C.skinDark);
    // Front arm
    r(ctx, 11, 8, 2, 6, C.shirt);
    r(ctx, 11 + armSwing, 13, 3, 2, C.skin);

    // --- Back leg ---
    r(ctx, backX, 16, 3, backY - 16, C.pants);
    r(ctx, backX - 1, backY, 4, 2, C.shoes);

    // --- Front leg (drawn on top) ---
    r(ctx, frontX, 16, 3, frontY - 16, C.pants);
    r(ctx, frontX, frontY, 5, 2, C.shoes);

    return c;
  });
}

// ── char_sleep.png — 2 frames, 32×32 ─────────────────────────────────────────
// Frame 0: head drooped to row 10 on arms, arms flat on desk
// Frame 1: same + small 'z' at x=11, y=6 (purple)
function genSleep(): Canvas[] {
  return [0, 1].map((i) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // Arms flat on desk (rows 12-14)
    r(ctx, 2, 12, 12, 3, C.skin);
    // Shirt sleeves on top of arms
    r(ctx, 2, 12, 3, 1, C.shirt);
    r(ctx, 11, 12, 3, 1, C.shirt);

    // Head drooped down — resting on arms at row 10
    // Hair
    r(ctx, 4, 10, 8, 2, C.hair);
    // Face (partially visible, drooped)
    r(ctx, 5, 12, 6, 3, C.skin);
    r(ctx, 4, 12, 1, 2, C.hair);
    r(ctx, 11, 12, 1, 2, C.hair);
    // Closed eyes (lines)
    r(ctx, 6, 13, 1, 1, C.pupil);
    r(ctx, 9, 13, 1, 1, C.pupil);

    // Torso (visible above arms)
    r(ctx, 4, 7, 8, 5, C.shirt);
    r(ctx, 7, 7, 2, 1, C.skin); // collar

    // Desk
    drawDesk16(ctx);

    // ZZZ — frame 0: one small z, frame 1: two z's
    // Small z at x=11, y=6
    r(ctx, 11, 6, 3, 1, C.zzz);
    r(ctx, 13, 7, 1, 1, C.zzz);
    r(ctx, 12, 8, 1, 1, C.zzz);
    r(ctx, 11, 9, 3, 1, C.zzz);

    if (i === 1) {
      // Larger Z above
      r(ctx, 13, 2, 2, 1, C.zzz);
      r(ctx, 14, 3, 1, 1, C.zzz);
      r(ctx, 13, 4, 2, 1, C.zzz);
    }

    return c;
  });
}

// ── char_coffee.png — 4 frames, 64×32 ────────────────────────────────────────
// Frame 0: mug on desk at x=11, y=14
// Frame 1: right arm raised, mug at x=12, y=11
// Frame 2: mug at mouth level x=9, y=7
// Frame 3: same as frame 1 (lowering)
function genCoffee(): Canvas[] {
  type MugPos = { mx: number; my: number; handY: number };
  const configs: MugPos[] = [
    { mx: 11, my: 14, handY: 15 }, // frame 0: mug on desk
    { mx: 12, my: 11, handY: 11 }, // frame 1: raised
    { mx: 9,  my: 7,  handY: 7  }, // frame 2: at mouth
    { mx: 12, my: 11, handY: 11 }, // frame 3: lowering (same as 1)
  ];

  return configs.map(({ mx, my, handY }) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    drawHead16(ctx, 8, 1);
    drawTorso16(ctx);
    // Left arm stays on desk
    drawLeftArm(ctx, 15);
    // Right arm raised to handY
    drawRightArmRaised(ctx, handY, mx - 1);
    drawDesk16(ctx);
    // Mug body
    r(ctx, mx,     my,     4, 4, C.mug);
    // Mug highlight
    r(ctx, mx,     my,     2, 1, '#f07060');
    // Mug handle
    r(ctx, mx + 4, my + 1, 1, 2, C.mug);
    // Coffee liquid top (dark)
    r(ctx, mx + 1, my,     2, 1, '#5c1a00');
    return c;
  });
}

// ── Save sprite sheet ─────────────────────────────────────────────────────────
function saveSheet(name: string, frames: Canvas[]): void {
  const totalW = W * frames.length;
  const sheet = createCanvas(totalW, H);
  const ctx = sheet.getContext('2d');
  ctx.clearRect(0, 0, totalW, H);
  for (let i = 0; i < frames.length; i++) {
    ctx.drawImage(frames[i], i * W, 0);
  }
  const buf = sheet.toBuffer('image/png');
  const outPath = path.join(OUT, `${name}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`  saved ${name}.png  (${frames.length} frame${frames.length > 1 ? 's' : ''}, ${totalW}×${H}px)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`Generating sprites → ${OUT}\n`);

  saveSheet('char_idle',   genIdle());    // 1 frame  16×32
  saveSheet('char_type',   genType());    // 2 frames 32×32
  saveSheet('char_read',   genRead());    // 2 frames 32×32
  saveSheet('char_walk_d', genWalkD());   // 4 frames 64×32
  saveSheet('char_walk_r', genWalkR());   // 4 frames 64×32
  saveSheet('char_walk_u', genWalkU());   // 4 frames 64×32
  saveSheet('char_sleep',  genSleep());   // 2 frames 32×32
  saveSheet('char_coffee', genCoffee());  // 4 frames 64×32

  console.log('\nAll 8 sprite sheets generated.');
}

main();
