// Node tests for the pure engine. Drawing = pinch (landmark geometry); erasing
// = the trained Closed_Fist label (passed in here directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { GestureController, Strokes, OneEuro, SwipeDetector, FistClench, UndoHistory, isFist, handOpenness, isShake, recognizeShape, transformPoint, twoHandDelta } = require("../src/page/engine.js");
const { GESTURES } = require("../src/page/bindings.js");

// The controller is generic — it runs over the gesture DEFINITIONS from
// bindings.js. Build one the same way the pipeline does.
const mkController = (opts) => new GestureController(GESTURES, opts);

// --- shape generators (aspect = 1, so square/round come out clean) ---
function linePts(a, b, n = 20) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  });
}
function circlePts(cx, cy, r, n = 28) {
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
  });
}
function polyPts(corners, per = 7) {
  const o = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    for (let j = 0; j < per; j++) {
      const t = j / per;
      o.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  o.push({ ...corners[0] });
  return o;
}
// Rectangle with rounded corners (radius r px) — what a real hand-drawn box
// looks like after smoothing. Should still be recognized as a rectangle.
function roundRectPts(x0, y0, x1, y1, r) {
  const seq = [];
  const push = (x, y) => seq.push({ x: x / 640, y: y / 480 });
  const arc = (cx, cy, a0, a1) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + ((a1 - a0) * i) / 6;
      push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  };
  for (let i = 0; i <= 6; i++) push(x0 + r + ((x1 - r - (x0 + r)) * i) / 6, y0);
  arc(x1 - r, y0 + r, -Math.PI / 2, 0);
  for (let i = 0; i <= 6; i++) push(x1, y0 + r + ((y1 - r - (y0 + r)) * i) / 6);
  arc(x1 - r, y1 - r, 0, Math.PI / 2);
  for (let i = 0; i <= 6; i++) push(x1 - r + ((x0 + r - (x1 - r)) * i) / 6, y1);
  arc(x0 + r, y1 - r, Math.PI / 2, Math.PI);
  for (let i = 0; i <= 6; i++) push(x0, y1 - r + ((y0 + r - (y1 - r)) * i) / 6);
  arc(x0 + r, y0 + r, Math.PI, Math.PI * 1.5);
  return seq;
}
function squiggle(n = 30) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { x: 0.2 + 0.6 * t, y: 0.5 + 0.14 * Math.sin(t * 9) };
  });
}

// A clean pinch pose: index extended toward the thumb (gap apart => ratio
// gap/0.2), middle/ring/pinky curled. Wrist (0.5,0.85), mid MCP (0.5,0.65).
function hand(gap, ix = 0.4, iy = 0.4) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.85, z: 0 };
  lm[9] = { x: 0.5, y: 0.65, z: 0 };
  lm[13] = { x: 0.55, y: 0.65, z: 0 };
  lm[17] = { x: 0.6, y: 0.65, z: 0 };
  lm[8] = { x: ix, y: iy, z: 0 }; // index tip (near the thumb)
  lm[4] = { x: ix + gap, y: iy, z: 0 };
  lm[12] = { x: 0.5, y: 0.78, z: 0 }; // middle curled
  lm[16] = { x: 0.55, y: 0.78, z: 0 }; // ring curled
  lm[20] = { x: 0.6, y: 0.78, z: 0 }; // pinky curled
  return lm;
}
// Posed hands with real finger extension (wrist at bottom, fingers up).
function poseHand(exts, thumb = { x: 0.32, y: 0.72 }) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.9, z: 0 };
  const mcps = { index: [5, 0.44], middle: [9, 0.5], ring: [13, 0.56], pinky: [17, 0.62] };
  const tips = { index: 8, middle: 12, ring: 16, pinky: 20 };
  for (const k of ["index", "middle", "ring", "pinky"]) {
    const [mcpI, x] = mcps[k];
    lm[mcpI] = { x, y: 0.6, z: 0 };
    lm[tips[k]] = { x, y: exts[k] ? 0.28 : 0.74, z: 0 }; // extended up vs curled down
  }
  lm[4] = { x: thumb.x, y: thumb.y, z: 0 };
  return lm;
}
const fistHand = () => poseHand({ index: false, middle: false, ring: false, pinky: false });
// Five-finger pinch: all five tips converge to a point out in front of the palm.
function fivePinchHand() {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.9, z: 0 };
  lm[9] = { x: 0.5, y: 0.65, z: 0 };
  lm[5] = { x: 0.44, y: 0.65, z: 0 };
  lm[13] = { x: 0.56, y: 0.65, z: 0 };
  lm[17] = { x: 0.6, y: 0.65, z: 0 };
  lm[4] = { x: 0.48, y: 0.26, z: 0 };
  lm[8] = { x: 0.52, y: 0.24, z: 0 };
  lm[12] = { x: 0.5, y: 0.23, z: 0 };
  lm[16] = { x: 0.51, y: 0.26, z: 0 };
  lm[20] = { x: 0.49, y: 0.27, z: 0 };
  return lm;
}
// Middle-finger pinch (VR pinch dictionary): thumb tip touches the MIDDLE
// fingertip while the index stays extended and free.
function middlePinchHand() {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.85, z: 0 }; // wrist
  lm[9] = { x: 0.5, y: 0.65, z: 0 }; // middle MCP -> handSize ~0.2
  lm[5] = { x: 0.44, y: 0.65, z: 0 };
  lm[13] = { x: 0.56, y: 0.65, z: 0 };
  lm[17] = { x: 0.6, y: 0.65, z: 0 };
  lm[8] = { x: 0.4, y: 0.3, z: 0 }; // index extended, far from thumb
  lm[12] = { x: 0.5, y: 0.66, z: 0 }; // middle CURLED down to meet the thumb (not extended)
  lm[4] = { x: 0.5, y: 0.64, z: 0 }; // thumb touching the curled middle tip
  lm[16] = { x: 0.58, y: 0.78, z: 0 }; // ring curled away
  lm[20] = { x: 0.62, y: 0.78, z: 0 }; // pinky curled away
  return lm;
}
// Five-finger pinch where each finger sits distance `off` FROM THE THUMB TIP
// (the metric fivePinch actually uses). handSize (wrist->midMCP) is 0.25, so
// spread ratio = off / 0.25. Opening the hand = fingers move away from the thumb.
function fivePinchSpread(off) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.9, z: 0 };
  lm[9] = { x: 0.5, y: 0.65, z: 0 };
  lm[5] = { x: 0.46, y: 0.65, z: 0 };
  lm[13] = { x: 0.54, y: 0.65, z: 0 };
  lm[17] = { x: 0.58, y: 0.65, z: 0 };
  const thumb = { x: 0.5, y: 0.28 };
  lm[4] = { x: thumb.x, y: thumb.y, z: 0 };
  const ang = [0.3, 1.6, 2.9, 4.2];
  [8, 12, 16, 20].forEach((t, i) => {
    lm[t] = { x: thumb.x + off * Math.cos(ang[i]), y: thumb.y + off * Math.sin(ang[i]), z: 0 };
  });
  return lm;
}
// Scale a whole hand about the image centre (simulates moving toward the camera).
function scaleHand(lm, k, cx = 0.5, cy = 0.5) {
  return lm.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k, z: 0 }));
}
// An index-pinch (draw) with the other three fingers curled toward the palm by
// `curl` (0 = at the knuckle line, 1 = down near the wrist). Thumb meets the
// index out front. This is the pose that used to false-trip a five-pinch.
function drawPinchCurled(curl) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.9, z: 0 }; // wrist
  lm[9] = { x: 0.5, y: 0.6, z: 0 }; // middle MCP -> handSize 0.3
  lm[5] = { x: 0.44, y: 0.6, z: 0 };
  lm[13] = { x: 0.56, y: 0.6, z: 0 };
  lm[17] = { x: 0.6, y: 0.6, z: 0 };
  lm[8] = { x: 0.4, y: 0.3, z: 0 }; // index tip out front
  lm[4] = { x: 0.43, y: 0.31, z: 0 }; // thumb meeting the index
  const cy = 0.6 + 0.25 * curl; // curled tips move from knuckles toward the wrist
  lm[12] = { x: 0.5, y: cy, z: 0 };
  lm[16] = { x: 0.55, y: cy, z: 0 };
  lm[20] = { x: 0.59, y: cy, z: 0 };
  return lm;
}
const victoryHand = () => poseHand({ index: true, middle: true, ring: false, pinky: false });
const openHand = () => poseHand({ index: true, middle: true, ring: true, pinky: true });
// Rotate a whole hand about the image centre — distances are preserved, so any
// landmark-distance test must be unaffected (rotation invariance).
function rotate(lm, ang, cx = 0.5, cy = 0.5) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return lm.map((p) => ({ x: cx + (p.x - cx) * c - (p.y - cy) * s, y: cy + (p.x - cx) * s + (p.y - cy) * c, z: 0 }));
}
function feed(c, lm, gesture, mirror, n, t0 = 0) {
  let g;
  for (let i = 0; i < n; i++) g = c.update(lm, gesture, mirror, t0 + i * 16);
  return g;
}

test("pinch draws (pen mode); cursor tracks the index tip", () => {
  const c = mkController();
  const g = feed(c, hand(0.04, 0.3, 0.35), null, false, 3); // ratio 0.2 -> down
  assert.equal(g.gesture, "pinch");
  assert.ok(Math.abs(g.point.x - 0.3) < 1e-6 && Math.abs(g.point.y - 0.35) < 1e-6);
});

test("curling the other fingers while drawing does NOT flip to five-pinch (pen holds)", () => {
  // the reported bug: mid-stroke, ring/pinky curl a bit → used to become SRP mode
  for (const curl of [0, 0.3, 0.6, 1]) {
    const c = mkController();
    const g = feed(c, drawPinchCurled(curl), null, false, 5);
    assert.equal(g.gesture, "pinch", `curl=${curl} must stay draw, got '${g.gesture}'`);
    assert.equal(fivePinch(drawPinchCurled(curl)).on, false, `curl=${curl} is not a five-pinch`);
  }
});

test("victory (peace sign) = 'victory' gesture; cursor sits BETWEEN the two fingertips", () => {
  const c = mkController();
  const g = feed(c, victoryHand(), null, false, 5);
  assert.equal(g.gesture, "victory");
  // victoryHand extends index (mcp x=0.44) and middle (mcp x=0.5); the cursor
  // should land at their tips' midpoint, not on a single fingertip.
  const lm = victoryHand();
  assert.ok(Math.abs(g.point.x - (lm[8].x + lm[12].x) / 2) < 1e-6, "x is the midpoint of the two tips");
  assert.ok(Math.abs(g.point.y - (lm[8].y + lm[12].y) / 2) < 1e-6, "y is the midpoint of the two tips");
});

test("victory works with the two fingers JOINED (together), not only spread", () => {
  const c = mkController();
  // index + middle both extended straight up and touching (x≈equal)
  const joined = poseHand({ index: true, middle: true, ring: false, pinky: false }, { x: 0.72, y: 0.5 });
  joined[8] = { x: 0.5, y: 0.28, z: 0 };
  joined[12] = { x: 0.51, y: 0.28, z: 0 };
  assert.equal(feed(c, joined, null, false, 5).gesture, "victory");
});

test("middle pinch = 'middlePinch' gesture (bound to erase)", () => {
  const c = mkController();
  assert.equal(feed(c, middlePinchHand(), null, false, 5).gesture, "middlePinch");
});

test("five-pinch gesture is ROTATION-INVARIANT (any angle works)", () => {
  for (const deg of [0, 45, 90, 137, 180, 270]) {
    const ang = (deg * Math.PI) / 180;
    assert.equal(feed(mkController(), rotate(fivePinchHand(), ang), null, false, 5).gesture, "fivePinch", `five-pinch @ ${deg}°`);
  }
});

// A five-pinch tilted toward the camera foreshortens: the tip-cluster projects
// back near the palm, so the old depth "reach" gate collapses and the pose used
// to fall through to draw. Spread-only detection must keep it a five-pinch.
test("five-pinch survives foreshortening (tilted toward the lens) — not draw", () => {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.9, z: 0 }; // wrist
  lm[9] = { x: 0.5, y: 0.65, z: 0 };
  lm[5] = { x: 0.46, y: 0.65, z: 0 };
  lm[13] = { x: 0.54, y: 0.65, z: 0 };
  lm[17] = { x: 0.58, y: 0.65, z: 0 };
  // all five tips bunched right at the knuckle line (fingers pointing at camera)
  lm[4] = { x: 0.49, y: 0.66, z: 0 };
  lm[8] = { x: 0.51, y: 0.66, z: 0 };
  lm[12] = { x: 0.5, y: 0.64, z: 0 };
  lm[16] = { x: 0.51, y: 0.67, z: 0 };
  lm[20] = { x: 0.49, y: 0.65, z: 0 };
  const g = feed(mkController(), lm, null, false, 5).gesture;
  assert.equal(g, "fivePinch", `foreshortened five-pinch stayed '${g}'`);
});

test("grab freezes on release: five-pinch settled when held, NOT when opening", () => {
  const c = mkController();
  feed(c, fivePinchSpread(0.05), null, false, 5); // form + hold a tight cluster
  const held = c.update(fivePinchSpread(0.05), null, false, 100);
  assert.equal(held.gesture, "fivePinch");
  assert.equal(held.settled, true, "a stable hold is settled → grab commits");
  const opening = c.update(fivePinchSpread(0.095), null, false, 116); // fingers spreading
  assert.equal(opening.gesture, "fivePinch", "still a five-pinch while opening");
  assert.equal(opening.settled, false, "opening = not settled → grab FREEZES the scale");
});

test("depth move does NOT freeze the grab (spread is size-normalized)", () => {
  const c = mkController();
  feed(c, fivePinchSpread(0.05), null, false, 5);
  c.update(fivePinchSpread(0.05), null, false, 100);
  // move the whole hand toward the camera (30% bigger) — spread ratio unchanged
  const closer = c.update(scaleHand(fivePinchSpread(0.05), 1.3), null, false, 116);
  assert.equal(closer.gesture, "fivePinch");
  assert.equal(closer.settled, true, "moving in depth stays settled → zoom keeps working");
});

test("opening the pinch lifts the pen (idle)", () => {
  const c = mkController();
  feed(c, hand(0.04), null, false, 3); // down
  const g = feed(c, hand(0.18), null, false, 3, 100); // ratio 0.9 -> release
  assert.equal(g.gesture, "none");
});

test("mid-range pinch stays down (hysteresis)", () => {
  const c = mkController();
  feed(c, hand(0.04), null, false, 3);
  const g = feed(c, hand(0.09), null, false, 3, 100); // ratio 0.45, in band
  assert.equal(g.gesture, "pinch");
});

test("releasing the pinch stops drawing immediately (no squiggle tail)", () => {
  const c = mkController();
  feed(c, hand(0.04), null, false, 4); // firm pinch
  const steady = c.update(hand(0.04), null, false, 100);
  assert.equal(steady.gesture, "pinch");
  assert.equal(steady.settled, true, "settled pinch draws");
  // fingers start opening (ratio rising) — pen still down (hysteresis) but must
  // NOT be appending points anymore
  const releasing = c.update(hand(0.12), null, false, 116);
  assert.equal(releasing.gesture, "pinch", "pen still nominally down during release");
  assert.equal(releasing.settled, false, "no points appended while opening");
});

test("a single noisy frame does not toggle the pen", () => {
  const c = mkController();
  feed(c, hand(0.04), null, false, 4); // drawing
  const g = c.update(hand(0.2), null, false, 100); // one open frame
  assert.equal(g.gesture, "pinch");
});

test("a five-finger pinch is detected after the majority-vote window", () => {
  const c = mkController();
  assert.equal(feed(c, fivePinchHand(), null, false, 5).gesture, "fivePinch");
});

test("stray five-pinch frames in a majority of open hands do NOT trigger it", () => {
  const c = mkController();
  const seq = [fivePinchHand(), openHand(), openHand(), fivePinchHand(), openHand()]; // 2/5
  let g;
  seq.forEach((lm, i) => (g = c.update(lm, null, false, i * 16)));
  assert.equal(g.gesture, "none", "minority of fist frames must not trigger erase");
});

test("an open hand is idle (no pinch, no fist, no victory)", () => {
  const c = mkController();
  assert.equal(feed(c, openHand(), null, false, 5).gesture, "none");
});

test("pen coasts through a brief hand loss, then releases past the grace", () => {
  const c = mkController({ graceMs: 250 });
  feed(c, hand(0.04), null, false, 4, 1000);
  const coast = c.update(null, null, false, 1120);
  assert.equal(coast.gesture, "pinch");
  assert.equal(coast.coasting, true);
  assert.equal(coast.settled, false, "no ink appended while blind — pen isn't stuck down on release");
  const gone = c.update(null, null, false, 1400);
  assert.equal(gone.gesture, "none");
  assert.equal(gone.present, false);
});

test("mirror flips cursor x to display space", () => {
  const c = mkController();
  const g = c.update(hand(0.04, 0.2, 0.4), null, true, 0);
  assert.ok(Math.abs(g.point.x - 0.8) < 1e-6, "mirrored x = 1 - 0.2");
});

test("OneEuro smooths jitter but converges to a steady value", () => {
  const f = new OneEuro({ minCutoff: 1, beta: 0 });
  f.filter(0.5, 0);
  const noisy = f.filter(0.6, 16);
  assert.ok(noisy > 0.5 && noisy < 0.6);
  let v = noisy;
  for (let i = 2; i < 40; i++) v = f.filter(0.6, i * 16);
  assert.ok(Math.abs(v - 0.6) < 0.01);
});

test("Strokes: begin/extend/end builds one stroke; clear empties", () => {
  const s = new Strokes();
  s.begin({ x: 0.1, y: 0.1 }, "#fff", 6);
  s.extend({ x: 0.2, y: 0.2 });
  s.end();
  assert.equal(s.list.length, 1);
  assert.equal(s.list[0].points.length, 2);
  s.clear();
  assert.equal(s.list.length, 0);
});

test("Strokes: eraseAt splits a line, removing only points under the eraser", () => {
  const s = new Strokes();
  s.begin({ x: 0.0, y: 0.5 }, "#fff", 4);
  for (let i = 1; i <= 10; i++) s.extend({ x: i / 10, y: 0.5 });
  s.end();
  s.eraseAt({ x: 0.5, y: 0.5 }, 0.12);
  assert.equal(s.list.length, 2);
  assert.ok(s.list[0].points.every((p) => p.x < 0.5));
  assert.ok(s.list[1].points.every((p) => p.x > 0.5));
});

test("recognizeShape: a straight stroke becomes a line", () => {
  const s = recognizeShape(linePts({ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.32 }));
  assert.equal(s && s.kind, "line");
});

test("recognizeShape: a round stroke becomes an ellipse (circle)", () => {
  const s = recognizeShape(circlePts(0.5, 0.5, 0.2));
  assert.equal(s && s.kind, "ellipse");
});

test("recognizeShape: a square stroke becomes a 4-point polygon", () => {
  const sq = polyPts([
    { x: 0.2, y: 0.2 },
    { x: 0.6, y: 0.2 },
    { x: 0.6, y: 0.6 },
    { x: 0.2, y: 0.6 },
  ]);
  const s = recognizeShape(sq);
  assert.equal(s && s.kind, "poly");
  assert.equal(s.pts.length, 4);
});

test("recognizeShape: a rounded-corner rectangle is still a rectangle (not a circle)", () => {
  for (const r of [15, 35, 60]) {
    const s = recognizeShape(roundRectPts(120, 120, 520, 360, r), 640 / 480);
    assert.equal(s && s.kind, "poly", `rounded rect r=${r} should be a poly`);
    assert.equal(s.pts.length, 4);
  }
});

test("recognizeShape: a triangle stroke becomes a 3-point polygon", () => {
  const tri = polyPts([
    { x: 0.5, y: 0.2 },
    { x: 0.7, y: 0.6 },
    { x: 0.3, y: 0.6 },
  ]);
  const s = recognizeShape(tri);
  assert.equal(s && s.kind, "poly");
  assert.equal(s.pts.length, 3);
});

test("recognizeShape: a wobbly freehand squiggle is NOT corrected (returns null)", () => {
  assert.equal(recognizeShape(squiggle()), null);
});

test("recognizeShape: a tiny scribble is left alone", () => {
  assert.equal(recognizeShape(circlePts(0.5, 0.5, 0.005)), null);
});

test("Strokes.end(assist): a circular stroke is replaced by a clean ellipse", () => {
  const s = new Strokes();
  s.begin({ x: 0.7, y: 0.5 }, "#fff", 4);
  for (const p of circlePts(0.5, 0.5, 0.2)) s.extend(p);
  const shape = s.end(true, 1);
  assert.equal(shape && shape.kind, "ellipse");
  assert.equal(s.list.length, 1);
  assert.equal(s.list[0].kind, "ellipse");
  assert.equal(s.list[0].color, "#fff");
});

test("Strokes: a box drawn as 4 separate strokes is recognized as one rectangle", () => {
  const s = new Strokes();
  const edge = (a, b) => linePts(a, b, 6);
  const draw = (pts, t) => {
    s.begin(pts[0], "#fff", 4);
    for (const p of pts.slice(1)) s.extend(p);
    return s.end(true, 1, t);
  };
  draw(edge({ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }), 100); // top
  draw(edge({ x: 0.6, y: 0.2 }, { x: 0.6, y: 0.6 }), 200); // right
  draw(edge({ x: 0.6, y: 0.6 }, { x: 0.2, y: 0.6 }), 300); // bottom
  const shape = draw(edge({ x: 0.2, y: 0.6 }, { x: 0.2, y: 0.2 }), 400); // left → closes it
  assert.equal(shape && shape.kind, "poly");
  assert.equal(s.list.length, 1, "the 4 strokes collapse into one shape");
});

test("Strokes: a triangle drawn as 3 strokes is recognized as one triangle", () => {
  const s = new Strokes();
  const draw = (pts, t) => {
    s.begin(pts[0], "#fff", 4);
    for (const p of pts.slice(1)) s.extend(p);
    return s.end(true, 1, t);
  };
  const A = { x: 0.5, y: 0.2 };
  const B = { x: 0.7, y: 0.6 };
  const C = { x: 0.3, y: 0.6 };
  draw(linePts(A, B, 6), 100);
  draw(linePts(B, C, 6), 200);
  const shape = draw(linePts(C, A, 6), 300);
  assert.equal(shape && shape.kind, "poly");
  assert.equal(shape.pts.length, 3);
  assert.equal(s.list.length, 1);
});

test("Strokes: two unrelated strokes are NOT merged into a shape", () => {
  const s = new Strokes();
  const draw = (pts, t) => {
    s.begin(pts[0], "#fff", 4);
    for (const p of pts.slice(1)) s.extend(p);
    return s.end(true, 1, t);
  };
  draw(linePts({ x: 0.1, y: 0.1 }, { x: 0.15, y: 0.12 }, 5), 100); // tiny scribble
  draw(linePts({ x: 0.8, y: 0.8 }, { x: 0.85, y: 0.82 }, 5), 200); // far away
  assert.equal(s.list.length, 2, "unrelated strokes stay as strokes");
});

test("Strokes.end(assist=false): freehand is kept as a stroke", () => {
  const s = new Strokes();
  s.begin({ x: 0.2, y: 0.3 }, "#fff", 4);
  for (const p of linePts({ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.31 })) s.extend(p);
  s.end(false, 1);
  assert.equal(s.list[0].kind, "stroke");
});

test("Strokes: hitTest finds an item under the point; translate moves it", () => {
  const s = new Strokes();
  s.list.push({ kind: "line", color: "#fff", size: 4, a: { x: 0.2, y: 0.5 }, b: { x: 0.8, y: 0.5 } });
  assert.equal(s.hitTest({ x: 0.5, y: 0.5 }, 0.03), 0, "point on the line hits it");
  assert.equal(s.hitTest({ x: 0.5, y: 0.9 }, 0.03), -1, "far point misses");
  s.translate(0, 0.0, 0.2);
  assert.ok(Math.abs(s.list[0].a.y - 0.7) < 1e-9, "line moved down by 0.2");
});

test("transformAll: scale=2 about the centre doubles each item's distance from it", () => {
  const s = new Strokes();
  s.list.push({ kind: "stroke", color: "#fff", size: 4, points: [{ x: 0.6, y: 0.5 }] });
  s.transformAll(2, 0, { x: 0.5, y: 0.5 }, 1); // aspect=1: isotropic
  const p = s.list[0].points[0];
  // was 0.1 right of centre → now 0.2 right of centre
  assert.ok(Math.abs(p.x - 0.7) < 1e-9, "x distance doubled");
  assert.ok(Math.abs(p.y - 0.5) < 1e-9, "on the axis, y unchanged");
});

test("bounds(): world bbox spans all items, including off-frame; null when empty", () => {
  const s = new Strokes();
  assert.equal(s.bounds(), null, "no strokes → null");
  s.list.push({ kind: "line", color: "#fff", size: 4, a: { x: 0.2, y: 0.3 }, b: { x: 1.4, y: 0.9 } });
  s.list.push({ kind: "ellipse", color: "#fff", size: 4, cx: -0.1, cy: 0.5, rx: 0.05, ry: 0.2 });
  const b = s.bounds();
  assert.ok(Math.abs(b.minx - -0.15) < 1e-9, "minx reaches the ellipse left edge (off-frame)");
  assert.ok(Math.abs(b.maxx - 1.4) < 1e-9, "maxx reaches the line end (off-frame)");
  assert.ok(Math.abs(b.miny - 0.3) < 1e-9);
  assert.ok(Math.abs(b.maxy - 0.9) < 1e-9);
});

test("transformAll: rot=90° about the centre rotates a point (aspect=1)", () => {
  const s = new Strokes();
  s.list.push({ kind: "line", color: "#fff", size: 4, a: { x: 0.7, y: 0.5 }, b: { x: 0.7, y: 0.5 } });
  s.transformAll(1, Math.PI / 2, { x: 0.5, y: 0.5 }, 1);
  const a = s.list[0].a;
  // (0.2,0) about centre rotated +90° → (0,0.2): x back to centre, y below it
  assert.ok(Math.abs(a.x - 0.5) < 1e-9, "x → centre");
  assert.ok(Math.abs(a.y - 0.7) < 1e-9, "y → 0.2 below centre");
});

test("transformAll: ellipse centre transforms and radii scale by the factor", () => {
  const s = new Strokes();
  s.list.push({ kind: "ellipse", color: "#fff", size: 4, cx: 0.6, cy: 0.5, rx: 0.1, ry: 0.05 });
  s.transformAll(2, 0, { x: 0.5, y: 0.5 }, 1);
  const e = s.list[0];
  assert.ok(Math.abs(e.cx - 0.7) < 1e-9, "centre moved out");
  assert.ok(Math.abs(e.rx - 0.2) < 1e-9 && Math.abs(e.ry - 0.1) < 1e-9, "radii scaled");
});

test("transformPoint: aspect correction makes a 90° rotation isotropic", () => {
  // A point 0.1 to the right of centre in x should map to 0.1·(1/aspect) in y
  // after a +90° turn, because y spans a smaller world-distance than x.
  const aspect = 2;
  const p = transformPoint({ x: 0.6, y: 0.5 }, 1, Math.PI / 2, { x: 0.5, y: 0.5 }, aspect);
  assert.ok(Math.abs(p.x - 0.5) < 1e-9, "x returns to centre");
  assert.ok(Math.abs(p.y - (0.5 + 0.1 * aspect)) < 1e-9, "y offset is aspect-scaled");
});

test("twoHandDelta: pure scale when the pinch pair stretches, no rotation", () => {
  const d = twoHandDelta({ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 });
  assert.ok(Math.abs(d.scale - 2) < 1e-9, "0.2 span → 0.4 span = 2×");
  assert.ok(Math.abs(d.rotate) < 1e-9, "collinear move = no rotation");
  assert.ok(Math.abs(d.center.x - 0.5) < 1e-9 && Math.abs(d.center.y - 0.5) < 1e-9, "center = midpoint");
});

test("twoHandDelta: pure rotation when the pinch pair turns, scale ~1", () => {
  // horizontal vector → vertical vector = +90°
  const d = twoHandDelta({ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.5, y: 0.4 }, { x: 0.5, y: 0.6 });
  assert.ok(Math.abs(d.scale - 1) < 1e-9, "same length = no scale");
  assert.ok(Math.abs(d.rotate - Math.PI / 2) < 1e-9, "quarter-turn");
});

test("Strokes.eraseAt deletes a whole shape it touches, keeps others", () => {
  const s = new Strokes();
  s.list.push({ kind: "ellipse", color: "#fff", size: 4, cx: 0.3, cy: 0.3, rx: 0.1, ry: 0.1 });
  s.list.push({ kind: "ellipse", color: "#fff", size: 4, cx: 0.8, cy: 0.8, rx: 0.1, ry: 0.1 });
  s.eraseAt({ x: 0.3, y: 0.3 }, 0.05);
  assert.equal(s.list.length, 1);
  assert.ok(Math.abs(s.list[0].cx - 0.8) < 1e-9, "the untouched shape remains");
});

// --- regression tests for bug-hunt findings ---
function ovalPts(cx, cy, rx, ry, n = 32) {
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  });
}
function arcPts(cx, cy, r, frac, n = 28) {
  return Array.from({ length: n }, (_, i) => {
    const t = 2 * Math.PI * frac * (i / (n - 1));
    return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
  });
}

test("recognizeShape: a 2:1 oval stays an oval (rx != ry), not forced round", () => {
  const s = recognizeShape(ovalPts(0.5, 0.5, 0.3, 0.15));
  assert.equal(s && s.kind, "ellipse");
  assert.ok(s.rx > s.ry * 1.6, `oval must keep its aspect: rx=${s && s.rx} ry=${s && s.ry}`);
});

test("recognizeShape: an open ~260deg arc does NOT snap to a circle", () => {
  assert.equal(recognizeShape(arcPts(0.5, 0.5, 0.3, 0.72)), null);
});

test("recognizeShape: a ~90% circle still snaps to an ellipse", () => {
  assert.equal((recognizeShape(arcPts(0.5, 0.5, 0.3, 0.9)) || {}).kind, "ellipse");
});

test("a five-finger pinch never reads as the draw pinch (index+thumb are together)", () => {
  const c = mkController();
  let drew = false;
  // draw only happens when the gesture is the index 'pinch'; a five-pinch must
  // never be classified as that (the clustered dead-zone suppresses penDown).
  for (let i = 0; i < 6; i++) if (c.update(fivePinchHand(), null, false, i * 16).gesture === "pinch") drew = true;
  assert.equal(drew, false, "a five-pinch must never read as draw");
  assert.equal(c.update(fivePinchHand(), null, false, 200).gesture, "fivePinch");
});

test("gesture classification is MIRROR-invariant", () => {
  assert.equal(feed(mkController(), fivePinchHand(), null, false, 5).gesture, "fivePinch");
  assert.equal(feed(mkController(), fivePinchHand(), null, true, 5).gesture, "fivePinch");
});

// --- compound motion gesture: fist + fast horizontal swipe = clear ---
test("SwipeDetector: a fast wide horizontal swipe fires exactly once", () => {
  const s = new SwipeDetector();
  let fires = 0;
  for (let i = 0; i <= 10; i++) if (s.update(true, { x: i * 0.06, y: 0.5 }, i * 30)) fires++; // 0→0.6 in 300ms
  assert.equal(fires, 1);
});

test("SwipeDetector: a slow horizontal drift does NOT fire", () => {
  const s = new SwipeDetector();
  let fired = false;
  for (let i = 0; i <= 20; i++) if (s.update(true, { x: i * 0.03, y: 0.5 }, i * 100)) fired = true; // 0→0.6 in 2s
  assert.equal(fired, false);
});

test("SwipeDetector: a vertical swipe does NOT fire (must be horizontal)", () => {
  const s = new SwipeDetector();
  let fired = false;
  for (let i = 0; i <= 10; i++) if (s.update(true, { x: 0.5, y: i * 0.06 }, i * 30)) fired = true;
  assert.equal(fired, false);
});

test("SwipeDetector: releasing the pose (inactive) resets and re-arms", () => {
  const s = new SwipeDetector();
  for (let i = 0; i <= 10; i++) s.update(true, { x: i * 0.06, y: 0.5 }, i * 30); // fires
  assert.equal(s.update(false, null, 400), false); // release → reset
  let fires = 0;
  for (let i = 0; i <= 10; i++) if (s.update(true, { x: i * 0.06, y: 0.5 }, 1000 + i * 30)) fires++;
  assert.equal(fires, 1, "a second swipe after releasing fires again");
});

// --- compound: double fist-clench + finger-count detector ---
// FistClench.update(present, fingersUp, now): 0=fist, >=3=open, 1-2=neutral.
const FIST = 0;
const OPEN = 4;
const PARTIAL = 2;

test("isFist / handOpenness: finger counts", () => {
  assert.equal(isFist(fistHand()), true, "a fist is a fist");
  assert.equal(handOpenness(fistHand()), 0, "fist = 0 fingers up");
  assert.equal(handOpenness(openHand()), 4, "open = 4 fingers up");
  assert.equal(isFist(openHand()), false, "open hand is not a fist");
  assert.equal(handOpenness(null), -1, "no landmarks → -1");
});

test("FistClench: two clenches (open→fist twice) fire exactly once", () => {
  const f = new FistClench({ window: 900, minGap: 120, settle: 250 });
  let fires = 0;
  const step = (present, up, t) => {
    if (f.update(present, up, t)) fires++;
  };
  step(true, OPEN, 0); // present + open
  step(true, OPEN, 300); // ...settled
  step(true, FIST, 350); // clench 1
  step(true, OPEN, 500); // open again
  step(true, FIST, 700); // clench 2 → fire
  step(true, FIST, 720); // held → no re-fire
  assert.equal(fires, 1);
});

test("FistClench: MOVING a fist (fist↔partial jitter) never fires — the reported bug", () => {
  const f = new FistClench({ settle: 250 });
  let fires = 0;
  const step = (up, t) => {
    if (f.update(true, up, t)) fires++;
  };
  step(OPEN, 0);
  step(OPEN, 300); // settled with an open hand once
  step(FIST, 350); // one real clench (now holding a fist)
  // now drag the fist around: tracking noise flips fist↔1-2 fingers, never OPEN
  for (let t = 400; t < 1400; t += 40) step(t % 80 === 0 ? PARTIAL : FIST, t);
  assert.equal(fires, 0, "fist-motion jitter must never reach a 2nd clench");
});

test("FistClench: a single clench (held) never fires", () => {
  const f = new FistClench();
  let fires = 0;
  f.update(true, OPEN, 0);
  f.update(true, OPEN, 300);
  if (f.update(true, FIST, 350)) fires++; // one clench
  for (let t = 390; t < 1600; t += 40) if (f.update(true, FIST, t)) fires++; // held
  assert.equal(fires, 0);
});

test("FistClench: entering the frame ALREADY a fist does NOT fire", () => {
  const f = new FistClench({ settle: 250 });
  let fires = 0;
  const step = (present, up, t) => {
    if (f.update(present, up, t)) fires++;
  };
  step(false, -1, 0); // out of frame
  step(true, FIST, 100); // enters as a fist (no prior OPEN → no clench)
  step(true, FIST, 400);
  step(false, -1, 500); // leaves
  step(true, FIST, 700); // re-enters fisted
  step(true, FIST, 1000);
  assert.equal(fires, 0, "appearing already-fisted must never count as a clench");
});

test("FistClench: clenches during the settle window are ignored", () => {
  const f = new FistClench({ settle: 250 });
  let fires = 0;
  const step = (up, t) => {
    if (f.update(true, up, t)) fires++;
  };
  step(OPEN, 0);
  step(FIST, 80); // <250ms present → ignored
  step(OPEN, 140);
  step(FIST, 200); // still <250ms → ignored
  assert.equal(fires, 0);
});

test("FistClench: two clenches too far apart do NOT fire", () => {
  const f = new FistClench({ window: 900, settle: 0 });
  let fires = 0;
  const step = (up, t) => {
    if (f.update(true, up, t)) fires++;
  };
  step(OPEN, 0);
  step(FIST, 50); // clench 1
  step(OPEN, 100);
  step(FIST, 1100); // >900ms after clench 1 → first dropped, no fire
  assert.equal(fires, 0);
});

// --- undo / redo history ---
test("UndoHistory: commit / undo / redo walks the states in order", () => {
  const h = new UndoHistory({ max: 10 });
  h.init("A");
  assert.equal(h.canUndo(), false);
  h.commit("B");
  h.commit("C");
  assert.equal(h.undoTo(), "B"); // C → B
  assert.equal(h.undoTo(), "A"); // B → A
  assert.equal(h.undoTo(), null, "at the start, nothing more to undo");
  assert.equal(h.redoTo(), "B"); // A → B
  assert.equal(h.redoTo(), "C"); // B → C
  assert.equal(h.redoTo(), null, "at the tip, nothing more to redo");
});

test("UndoHistory: a fresh commit clears the redo branch", () => {
  const h = new UndoHistory();
  h.init("A");
  h.commit("B");
  h.commit("C");
  h.undoTo(); // → B, redo now holds C
  assert.equal(h.canRedo(), true);
  h.commit("D"); // new branch
  assert.equal(h.canRedo(), false, "redo is dropped after a new edit");
  assert.equal(h.undoTo(), "B");
});

test("UndoHistory: past is capped at max", () => {
  const h = new UndoHistory({ max: 2 });
  h.init("s0");
  for (let i = 1; i <= 5; i++) h.commit("s" + i);
  assert.ok(h.past.length <= 2, `past length ${h.past.length} must be ≤ 2`);
  assert.equal(h.current, "s5");
});

// --- shake-to-cancel detector ---
test("isShake: a fast back-and-forth zigzag reads as a shake", () => {
  const pts = [];
  for (let i = 0; i < 12; i++) pts.push({ x: 0.5 + (i % 2 ? 0.12 : -0.12), y: 0.5 }); // hard L-R flips
  assert.equal(isShake(pts), true);
});

test("isShake: a straight drag is NOT a shake", () => {
  const pts = Array.from({ length: 12 }, (_, i) => ({ x: 0.1 + i * 0.06, y: 0.5 })); // one direction
  assert.equal(isShake(pts), false);
});

test("isShake: a gentle short move is NOT a shake", () => {
  const pts = Array.from({ length: 8 }, (_, i) => ({ x: 0.5 + i * 0.005, y: 0.5 + i * 0.004 }));
  assert.equal(isShake(pts), false);
});

// --- draw de-spiking (median-of-3 removes single-frame mistrokes) ---
test("Strokes.extend de-spikes a single-frame outlier off the movement line", () => {
  const s = new Strokes();
  s.begin({ x: 0.1, y: 0.5 }, "#fff", 4);
  s.extend({ x: 0.2, y: 0.5 });
  s.extend({ x: 0.3, y: 0.62 }); // SPIKE: darts off the line
  s.extend({ x: 0.4, y: 0.5 }); // returns to the line
  const spike = s.current.points[2];
  assert.ok(Math.abs(spike.y - 0.5) < 1e-9, `spike y pulled back to 0.5, got ${spike.y}`);
  assert.ok(Math.abs(spike.x - 0.3) < 1e-9, "x preserved (median 0.2,0.3,0.4 = 0.3)");
});

test("Strokes.extend preserves a genuine trend (a real diagonal is NOT flattened)", () => {
  const s = new Strokes();
  s.begin({ x: 0.1, y: 0.1 }, "#fff", 4);
  for (const v of [0.2, 0.3, 0.4]) s.extend({ x: v, y: v });
  const pts = s.current.points;
  assert.ok(Math.abs(pts[1].x - 0.2) < 1e-9 && Math.abs(pts[1].y - 0.2) < 1e-9, "diagonal point 1 intact");
  assert.ok(Math.abs(pts[2].x - 0.3) < 1e-9 && Math.abs(pts[2].y - 0.3) < 1e-9, "diagonal point 2 intact");
});

// --- single-object transform + pan ---
test("Strokes.transformItem transforms ONLY the targeted item", () => {
  const s = new Strokes();
  s.list.push({ kind: "line", color: "#fff", size: 4, a: { x: 0.4, y: 0.5 }, b: { x: 0.6, y: 0.5 } });
  s.list.push({ kind: "line", color: "#fff", size: 4, a: { x: 0.4, y: 0.9 }, b: { x: 0.6, y: 0.9 } });
  s.transformItem(0, 2, 0, { x: 0.5, y: 0.5 }, 1); // scale item 0 by 2 about its centre
  assert.ok(Math.abs(s.list[0].a.x - 0.3) < 1e-9, "item 0 scaled (0.4 -> 0.3)");
  assert.ok(Math.abs(s.list[1].a.x - 0.4) < 1e-9, "item 1 untouched");
});

test("Strokes.translateAll pans every item by the same delta", () => {
  const s = new Strokes();
  s.list.push({ kind: "line", color: "#fff", size: 4, a: { x: 0.2, y: 0.2 }, b: { x: 0.3, y: 0.2 } });
  s.list.push({ kind: "ellipse", color: "#fff", size: 4, cx: 0.6, cy: 0.6, rx: 0.1, ry: 0.1 });
  s.translateAll(0.1, -0.05);
  assert.ok(Math.abs(s.list[0].a.x - 0.3) < 1e-9 && Math.abs(s.list[0].a.y - 0.15) < 1e-9);
  assert.ok(Math.abs(s.list[1].cx - 0.7) < 1e-9 && Math.abs(s.list[1].cy - 0.55) < 1e-9);
});

test("Strokes snapshot/restore enables absolute (drift-free) transforms", () => {
  const s = new Strokes();
  s.list.push({ kind: "ellipse", color: "#fff", size: 4, cx: 0.2, cy: 0.5, rx: 0.05, ry: 0.05 });
  s.list.push({ kind: "ellipse", color: "#fff", size: 4, cx: 0.8, cy: 0.5, rx: 0.05, ry: 0.05 });
  const snap = s.snapshot();
  // apply many incremental scales, then restore + one absolute 2x — must match group
  for (let i = 0; i < 20; i++) s.transformAll(1.03, 0.05, { x: 0.5, y: 0.5 }, 1);
  s.restore(snap);
  s.transformAll(2, 0, { x: 0.5, y: 0.5 }, 1);
  assert.ok(Math.abs(s.list[0].cx - -0.1) < 1e-9 && Math.abs(s.list[1].cx - 1.1) < 1e-9, "restore is a clean deep copy");
  assert.ok(Math.abs(s.list[0].rx - 0.1) < 1e-9, "radii scaled from the snapshot, not the drifted state");
});

// --- depth-based single-hand transform ---
const { depthTransform } = require("../src/page/engine.js");
test("depthTransform: REVERSED depth — closer hand (bigger) scales DOWN; wrist rotates; pos pans", () => {
  const d = depthTransform({ size: 0.2, angle: 0, pos: { x: 0.5, y: 0.5 } }, { size: 0.28, angle: 0.3, pos: { x: 0.6, y: 0.5 } }, { gain: 1 });
  assert.ok(Math.abs(d.scale - 0.2 / 0.28) < 1e-6, "closer (0.2->0.28) zooms OUT: 0.2/0.28");
  assert.ok(Math.abs(d.rotate - 0.3) < 1e-9);
  assert.ok(Math.abs(d.pan.x - 0.1) < 1e-9);
});

test("depthTransform: pulling the hand back (smaller) scales UP", () => {
  const d = depthTransform({ size: 0.2, angle: 0, pos: { x: 0, y: 0 } }, { size: 0.1, angle: 0, pos: { x: 0, y: 0 } }, { gain: 1 });
  assert.ok(Math.abs(d.scale - 2) < 1e-6, "0.2/0.1 = 2x (zoom in by pulling back)");
});

test("depthTransform: scale clamps to a sane range", () => {
  assert.equal(depthTransform({ size: 0.9, angle: 0, pos: { x: 0, y: 0 } }, { size: 0.01, angle: 0, pos: { x: 0, y: 0 } }).scale, 10);
});

test("Strokes.itemCenter returns the bounding-box centre", () => {
  const s = new Strokes();
  s.list.push({ kind: "line", color: "#fff", size: 4, a: { x: 0.2, y: 0.4 }, b: { x: 0.6, y: 0.8 } });
  const c = s.itemCenter(0);
  assert.ok(Math.abs(c.x - 0.4) < 1e-9 && Math.abs(c.y - 0.6) < 1e-9);
});

test("depthTransform: rotGain amplifies wrist roll into more rotation", () => {
  const base = depthTransform({ size: 0.2, angle: 0, pos: { x: 0, y: 0 } }, { size: 0.2, angle: 0.2, pos: { x: 0, y: 0 } }, { rotGain: 1 });
  const amp = depthTransform({ size: 0.2, angle: 0, pos: { x: 0, y: 0 } }, { size: 0.2, angle: 0.2, pos: { x: 0, y: 0 } }, { rotGain: 2.5 });
  assert.ok(Math.abs(base.rotate - 0.2) < 1e-9);
  assert.ok(Math.abs(amp.rotate - 0.5) < 1e-9, "2.5x more rotation for the same wrist roll");
});

// --- gesture separation: 2-finger pinch vs 5-finger pinch (the key ask) ---
const { fivePinch } = require("../src/page/engine.js");
test("index-pinch / middle-pinch / five-pinch are three distinct gestures", () => {
  assert.equal(feed(mkController(), hand(0.04), null, false, 5).gesture, "pinch");
  assert.equal(feed(mkController(), middlePinchHand(), null, false, 5).gesture, "middlePinch");
  assert.equal(feed(mkController(), fivePinchHand(), null, false, 5).gesture, "fivePinch");
});
test("fivePinch tells a 2-finger pinch from a 5-finger pinch", () => {
  assert.equal(fivePinch(fivePinchHand()).on, true, "all five tips together = five-pinch");
  assert.equal(fivePinch(hand(0.04)).on, false, "index+thumb only (others curled) = NOT a five-pinch");
});
