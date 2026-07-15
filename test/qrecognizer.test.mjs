// Node tests for the $P point-cloud recognizer (template / by-example shapes:
// arrows, checkmark, X, digits). Simple primitives live in engine.js and are
// tested separately. Points are {x,y} normalized 0..1; multi-stroke shapes are
// one concatenated array.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { QRecognizer, resample, normalize } = require("../src/page/qrecognizer.js");

// --- point-cloud generators (mirror how the built-ins are authored) ---
function seg(a, b, n = 12) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  });
}
// A drawn arrow: shaft + V head, optionally offset and scaled so we can test
// scale/translation invariance. cx,cy = centre; s = size.
function arrowPts(cx = 0.5, cy = 0.5, s = 1) {
  const P = (x, y) => ({ x: cx + (x - 0.5) * s, y: cy + (y - 0.5) * s });
  return [
    ...seg(P(0.1, 0.5), P(0.8, 0.5), 14),
    ...seg(P(0.58, 0.33), P(0.8, 0.5), 7),
    ...seg(P(0.8, 0.5), P(0.58, 0.67), 7),
  ];
}
function checkPts(cx = 0.5, cy = 0.5, s = 1) {
  const P = (x, y) => ({ x: cx + (x - 0.5) * s, y: cy + (y - 0.5) * s });
  return [...seg(P(0.2, 0.5), P(0.42, 0.8), 7), ...seg(P(0.42, 0.8), P(0.8, 0.2), 13)];
}
function xPts(cx = 0.5, cy = 0.5, s = 1) {
  const P = (x, y) => ({ x: cx + (x - 0.5) * s, y: cy + (y - 0.5) * s });
  return [...seg(P(0.22, 0.22), P(0.78, 0.78), 11), ...seg(P(0.78, 0.22), P(0.22, 0.78), 11)];
}
// A wobbly random squiggle — should be rejected by the intent gate.
function squiggle(n = 40) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { x: 0.2 + 0.6 * t, y: 0.5 + 0.18 * Math.sin(t * 11) + 0.05 * Math.cos(t * 23) };
  });
}

test("a synthetic arrow recognizes as 'arrow' above the gate", () => {
  const q = new QRecognizer();
  const r = q.recognize(arrowPts());
  assert.equal(r.name, "arrow");
  assert.ok(r.score >= q.minScore, `score ${r.score} should clear the gate`);
});

test("a synthetic checkmark recognizes as 'check'", () => {
  const q = new QRecognizer();
  assert.equal(q.recognize(checkPts()).name, "check");
});

test("a synthetic X recognizes as 'x'", () => {
  const q = new QRecognizer();
  assert.equal(q.recognize(xPts()).name, "x");
});

test("digits 0, 1, 7 are recognized", () => {
  const q = new QRecognizer();
  const zero = [];
  for (let i = 0; i < 30; i++) {
    const a = (2 * Math.PI * i) / 30;
    zero.push({ x: 0.5 + 0.3 * Math.cos(a), y: 0.5 + 0.3 * Math.sin(a) });
  }
  assert.equal(q.recognize(zero).name, "0");
  const one = [...seg({ x: 0.37, y: 0.33 }, { x: 0.5, y: 0.2 }, 5), ...seg({ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.82 }, 14), ...seg({ x: 0.37, y: 0.82 }, { x: 0.65, y: 0.82 }, 7)];
  assert.equal(q.recognize(one).name, "1");
  const seven = [...seg({ x: 0.25, y: 0.23 }, { x: 0.75, y: 0.23 }, 11), ...seg({ x: 0.75, y: 0.23 }, { x: 0.45, y: 0.8 }, 13)];
  assert.equal(q.recognize(seven).name, "7");
});

test("a random wobbly squiggle is rejected by the intent gate (name:null)", () => {
  const q = new QRecognizer();
  const r = q.recognize(squiggle());
  assert.equal(r.name, null);
  assert.equal(r.score, 0);
});

test("recognition is invariant to input scale (2x arrow => still 'arrow')", () => {
  const q = new QRecognizer();
  const small = q.recognize(arrowPts(0.5, 0.5, 0.5));
  const big = q.recognize(arrowPts(0.5, 0.5, 1.0));
  assert.equal(small.name, "arrow");
  assert.equal(big.name, "arrow");
  // normalization removes scale, so scores should be essentially identical
  assert.ok(Math.abs(small.score - big.score) < 1e-9, "score independent of size");
});

test("recognition is invariant to translation (offset X => still 'x')", () => {
  const q = new QRecognizer();
  const centred = q.recognize(xPts(0.5, 0.5, 0.6));
  const offset = q.recognize(xPts(0.25, 0.75, 0.6));
  assert.equal(offset.name, "x");
  assert.ok(Math.abs(centred.score - offset.score) < 1e-9, "score independent of position");
});

test("resample produces exactly N points", () => {
  const q = new QRecognizer();
  assert.equal(resample(arrowPts(), q.N).length, q.N);
  assert.equal(resample(seg({ x: 0, y: 0 }, { x: 1, y: 1 }, 3), 32).length, 32);
  assert.equal(resample(xPts(), 48).length, 48);
});

test("normalize centres the cloud on the origin and fits a unit box", () => {
  const norm = normalize(arrowPts(0.3, 0.7, 0.4), 32);
  const cx = norm.reduce((s, p) => s + p.x, 0) / norm.length;
  const cy = norm.reduce((s, p) => s + p.y, 0) / norm.length;
  assert.ok(Math.abs(cx) < 1e-9 && Math.abs(cy) < 1e-9, "centroid at origin");
  const span = (sel) => Math.max(...norm.map(sel)) - Math.min(...norm.map(sel));
  const larger = Math.max(span((p) => p.x), span((p) => p.y));
  assert.ok(Math.abs(larger - 1) < 1e-9, "larger dimension scaled to 1");
});

test("add() extends the recognizer with a new template by example", () => {
  const q = new QRecognizer({ builtins: false });
  q.add("vbar", seg({ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }, 12));
  q.add("hbar", seg({ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, 12));
  assert.equal(q.recognize(seg({ x: 0.5, y: 0.15 }, { x: 0.5, y: 0.85 }, 20)).name, "vbar");
  assert.equal(q.recognize(seg({ x: 0.15, y: 0.5 }, { x: 0.85, y: 0.5 }, 20)).name, "hbar");
});
