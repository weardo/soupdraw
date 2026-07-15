// SoupDraw — schematic hand model for the training ghost + live overlay.
//
// A pose is per-finger CURL (0 straight .. 1 folded into the palm) plus a thumb
// (abduct = how far out to the side, curl = folded across). Each finger is drawn
// by interpolating between a STRAIGHT keyframe (tip up) and a FOLDED keyframe (tip
// down near the knuckle), which is predictable and reads correctly. Two flags
// finish the tricky gestures: pinchTips (thumb + index tips touch) and cluster
// (all five tips gather — a five-finger pinch). Landmarks are MediaPipe order.
// Exposed as window.SoupHands.
(function (root) {
  "use strict";

  const BONES = [
    [0, 1], [1, 2], [2, 3], [3, 4], // thumb
    [0, 5], [5, 6], [6, 7], [7, 8], // index
    [9, 10], [10, 11], [11, 12], // middle
    [13, 14], [14, 15], [15, 16], // ring
    [0, 17], [17, 18], [18, 19], [19, 20], // pinky
    [5, 9], [9, 13], [13, 17], // knuckle line
  ];

  const WRIST = { x: 0.5, y: 0.9 };
  // MCP knuckle + finger length per finger.
  const KNUCK = {
    index: { m: { x: 0.40, y: 0.52 }, idx: [5, 6, 7, 8], L: 0.44 },
    middle: { m: { x: 0.50, y: 0.50 }, idx: [9, 10, 11, 12], L: 0.50 },
    ring: { m: { x: 0.59, y: 0.52 }, idx: [13, 14, 15, 16], L: 0.45 },
    pinky: { m: { x: 0.67, y: 0.55 }, idx: [17, 18, 19, 20], L: 0.36 },
  };

  const lerpP = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  // [mcp, pip, dip, tip] for a finger, curl 0..1.
  function fingerPts(m, L, curl) {
    const up = (f) => ({ x: m.x, y: m.y - f * L }); // straight: points up
    const straight = [{ ...m }, up(0.40), up(0.72), up(1.0)];
    const inx = m.x + (0.5 - m.x) * 0.2; // curled fingers pull slightly toward palm centre
    const folded = [
      { ...m },
      { x: m.x, y: m.y - 0.34 * L }, // pip still up a bit
      { x: inx, y: m.y - 0.30 * L }, // dip folds forward
      { x: inx, y: m.y - 0.05 * L }, // tip curls back down to the knuckle
    ];
    return straight.map((s, i) => lerpP(s, folded[i], curl));
  }

  // [cmc, mcp, ip, tip] for the thumb. abduct 1 = out to the side; 0 = across palm.
  function thumbPts(abduct, curl) {
    const cmc = { x: 0.34, y: 0.72 };
    const out = [cmc, { x: 0.27, y: 0.62 }, { x: 0.21, y: 0.53 }, { x: 0.16, y: 0.45 }];
    const across = [cmc, { x: 0.36, y: 0.61 }, { x: 0.44, y: 0.58 }, { x: 0.51, y: 0.56 }];
    const base = out.map((o, i) => lerpP(o, across[i], 1 - abduct));
    if (curl > 0) {
      base[3] = lerpP(base[3], cmc, curl * 0.35); // curl tugs the tip back toward the base
      base[2] = lerpP(base[2], cmc, curl * 0.2);
    }
    return base;
  }

  function buildHand(pose) {
    const lm = new Array(21);
    lm[0] = { ...WRIST };
    for (const name in KNUCK) {
      const f = KNUCK[name];
      const pts = fingerPts(f.m, f.L, pose[name] ?? 0);
      f.idx.forEach((i, k) => (lm[i] = pts[k]));
    }
    const th = thumbPts(pose.thumbAbduct ?? 0.8, pose.thumb ?? 0);
    [1, 2, 3, 4].forEach((i, k) => (lm[i] = th[k]));

    if (pose.pinchTips) {
      const mid = lerpP(lm[8], lm[4], 0.5);
      lm[8] = { ...mid };
      lm[4] = { ...mid };
    }
    if (pose.cluster) {
      const c = { x: 0.45, y: 0.42 };
      for (const i of [4, 8, 12, 16, 20]) lm[i] = lerpP(lm[i], c, 0.55);
    }
    return lm;
  }

  const POSES = {
    open: { index: 0, middle: 0, ring: 0, pinky: 0, thumb: 0, thumbAbduct: 0.9 },
    // thumb tip meets the index tip
    pinch: { index: 0.45, middle: 0.12, ring: 0.1, pinky: 0.1, thumb: 0.2, thumbAbduct: 0.12, pinchTips: true },
    // index + middle up, ring + pinky folded
    victory: { index: 0, middle: 0, ring: 1, pinky: 1, thumb: 0.55, thumbAbduct: 0.1 },
    // fist with the thumb sticking OUT (this is the eraser)
    fist: { index: 1, middle: 1, ring: 1, pinky: 1, thumb: 0.15, thumbAbduct: 0.9 },
    // fist with the thumb tucked ACROSS (grab / pan)
    closedFist: { index: 1, middle: 1, ring: 1, pinky: 1, thumb: 0.9, thumbAbduct: 0.05 },
    // all five fingertips gathered toward the thumb
    five: { index: 0.35, middle: 0.35, ring: 0.35, pinky: 0.35, thumb: 0.3, thumbAbduct: 0.15, cluster: true },
  };

  const lerp = (a, b, t) => a + (b - a) * t;
  function mixPose(a, b, t) {
    const out = {};
    for (const k of ["index", "middle", "ring", "pinky", "thumb", "thumbAbduct"]) out[k] = lerp(a[k] ?? 0, b[k] ?? 0, t);
    if (t > 0.6) {
      if (b.pinchTips) out.pinchTips = true;
      if (b.cluster) out.cluster = true;
    }
    return out;
  }

  function drawHand(ctx, lm, box, opts) {
    if (!lm || lm.length < 21) return;
    const o = opts || {};
    const px = (p) => ({ x: box.x + (o.mirror ? 1 - p.x : p.x) * box.w, y: box.y + p.y * box.h });
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = o.glow || "rgba(255,45,85,0.35)";
    ctx.shadowBlur = o.blur ?? 10;
    ctx.strokeStyle = o.stroke || "#ff2d55";
    ctx.lineWidth = o.width ?? 4;
    for (const [a, b] of BONES) {
      const pa = px(lm[a]);
      const pb = px(lm[b]);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // joints (bones' endpoints)
    ctx.fillStyle = o.joint || "#fff";
    const r = o.dot ?? 3.5;
    for (let i = 0; i < 21; i++) {
      const p = px(lm[i]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // fingertip POINTERS — a filled dot + ring on each tip so the action points
    // (what actually touches/moves) read clearly.
    const TIPS = [4, 8, 12, 16, 20];
    const tipCol = o.tip || o.stroke || "#ff2d55";
    for (const i of TIPS) {
      const p = px(lm[i]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = tipCol;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4.5, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = tipCol;
      ctx.stroke();
    }
    ctx.restore();
  }

  const api = { BONES, POSES, buildHand, mixPose, drawHand };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SoupHands = api;
})(typeof window !== "undefined" ? window : null);
