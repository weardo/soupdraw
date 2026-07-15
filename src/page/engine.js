// draw.me — gesture + drawing engine (pure logic, no getUserMedia).
// Gesture CLASSIFICATION comes entirely from MediaPipe's trained Gesture
// Recognizer (passed in as a label). This module only does pointer signal
// processing (One Euro smoothing + coasting) and the drawing model — never
// hand-rolled gesture heuristics.
// Exposes window.DrawMeEngine = { GestureController, Strokes, OneEuro }.
(function (root) {
  "use strict";

  // ---- One Euro filter ------------------------------------------------------
  // Adaptive low-pass: heavy smoothing when slow (kills jitter), light when
  // fast (no lag). https://gery.casiez.net/1euro/
  class LowPass {
    constructor() {
      this.s = null;
    }
    filter(x, a) {
      this.s = this.s === null ? x : a * x + (1 - a) * this.s;
      return this.s;
    }
  }
  class OneEuro {
    constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = dCutoff;
      this.x = new LowPass();
      this.dx = new LowPass();
      this.last = null;
      this.lastTime = null;
    }
    alpha(cutoff, dt) {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    }
    reset() {
      this.x = new LowPass();
      this.dx = new LowPass();
      this.last = null;
      this.lastTime = null;
    }
    filter(value, now) {
      let dt = 1 / 60;
      if (this.lastTime != null && now != null) {
        const d = (now - this.lastTime) / 1000;
        if (d > 0 && d < 1) dt = d;
      }
      this.lastTime = now;
      const dvalue = this.last == null ? 0 : (value - this.last) / dt;
      this.last = value;
      const edvalue = this.dx.filter(dvalue, this.alpha(this.dCutoff, dt));
      const cutoff = this.minCutoff + this.beta * Math.abs(edvalue);
      return this.x.filter(value, this.alpha(cutoff, dt));
    }
  }

  // Which fingers are extended, measured against the hand's OWN geometry: a
  // finger is extended when its tip is farther from the wrist than its base
  // knuckle (MCP). Because it only uses distances between landmarks, it is
  // invariant to how the hand is rotated in the image — any angle works.
  function fingerExtended(lm) {
    const w = lm[0];
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const ext = (mcp, tip) => d(lm[tip], w) > d(lm[mcp], w) * 1.1;
    return { index: ext(5, 8), middle: ext(9, 12), ring: ext(13, 16), pinky: ext(17, 20) };
  }

  // Thumb-tip distance from the palm centre, relative to hand size (rotation-
  // invariant). Small = tucked/bent, large = out/abducted. The raw signal behind
  // thumbExtended — surfaced so callers can calibrate the move/rotate threshold.
  function thumbDist(lm) {
    const w = lm[0];
    const mm = lm[9];
    const hs = Math.hypot(mm.x - w.x, mm.y - w.y) || 1e-3;
    let cx = 0;
    let cy = 0;
    for (const i of [0, 5, 9, 13, 17]) {
      cx += lm[i].x;
      cy += lm[i].y;
    }
    cx /= 5;
    cy /= 5;
    return Math.hypot(lm[4].x - cx, lm[4].y - cy) / hs;
  }
  // Is the THUMB out (vs bent in against the palm)? > threshold = out.
  function thumbExtended(lm, threshold = 0.7) {
    return thumbDist(lm) > threshold;
  }

  // How many of the four fingers (index/middle/ring/pinky) are extended: 0 = a
  // fist, 4 = wide open. -1 if no hand. The clench detector uses this to tell a
  // CLEAR open hand from a fist, ignoring the noisy 1-2 finger in-between states.
  function handOpenness(lm) {
    if (!lm || lm.length < 21) return -1;
    const e = fingerExtended(lm);
    return (e.index ? 1 : 0) + (e.middle ? 1 : 0) + (e.ring ? 1 : 0) + (e.pinky ? 1 : 0);
  }

  // Fist: all four fingers curled (none extended) and NOT a five-finger pinch
  // (fingers curl to the palm, not onto the thumb). Rotation-invariant (uses only
  // landmark distances). -> bool
  function isFist(lm) {
    if (!lm || lm.length < 21) return false;
    return handOpenness(lm) === 0 && !fivePinch(lm).on;
  }

  // Five-finger pinch ("grab"): every finger touches the THUMB. The test is the
  // worst (farthest) of index/middle/ring/pinky tip TO THE THUMB TIP, relative to
  // hand size. This is what separates it from a draw pinch: curling your other
  // fingers while drawing sends their tips toward the PALM — AWAY from the thumb
  // (which is out front meeting the index) — so this distance stays large and a
  // five-pinch never false-fires mid-stroke. (The old centroid-spread metric was
  // fooled: curled tips pulled the centroid forward and shrank the spread.) It's
  // a ratio of landmark distances, so it survives rotation + foreshortening at
  // any camera angle. -> { on, center:{x,y}, spread } (center unmirrored).
  function fivePinch(lm) {
    const w = lm[0];
    const hs = Math.hypot(lm[9].x - w.x, lm[9].y - w.y) || 1e-3;
    const thumb = lm[4];
    const fingers = [lm[8], lm[12], lm[16], lm[20]];
    let cx = thumb.x;
    let cy = thumb.y;
    let maxD = 0;
    for (const t of fingers) {
      maxD = Math.max(maxD, Math.hypot(t.x - thumb.x, t.y - thumb.y));
      cx += t.x;
      cy += t.y;
    }
    cx /= 5; // centroid of all five tips (the grab anchor)
    cy /= 5;
    const spread = maxD / hs; // worst finger's distance to the thumb tip
    return { on: spread < 0.6, center: { x: cx, y: cy }, spread };
  }

  // Generic double-tap: a boolean signal pulsed on-off-on within WINDOW ms fires
  // once (e.g. double five-finger-pinch to open history mode). MIN_GAP debounces
  // tracking jitter between the two pulses.
  class DoubleTap {
    constructor(opts = {}) {
      this.WINDOW = opts.window ?? 800;
      this.MIN_GAP = opts.minGap ?? 110;
      this.was = false;
      this.taps = [];
    }
    reset() {
      this.was = false;
      this.taps = [];
    }
    update(active, now) {
      const rising = active && !this.was;
      this.was = active;
      if (rising && (!this.taps.length || now - this.taps[this.taps.length - 1] >= this.MIN_GAP)) this.taps.push(now);
      while (this.taps.length && now - this.taps[0] > this.WINDOW) this.taps.shift();
      if (this.taps.length >= 2) {
        this.taps = [];
        return true;
      }
      return false;
    }
  }

  // Compound TEMPORAL gesture: clench the fist TWICE quickly (two open→fist
  // transitions inside WINDOW ms) → fires once. A "double clench", like a
  // double-click. The two-within-a-window gate separates it from a single grab
  // or an incidental fist, so it's a deliberate trigger (e.g. clear the board).
  class FistClench {
    constructor(opts = {}) {
      this.WINDOW = opts.window ?? 900; // ms to land BOTH clenches
      this.MIN_GAP = opts.minGap ?? 120; // ignore sub-gap jitter between transitions
      this.SETTLE = opts.settle ?? 250; // ignore clenches until the hand has been present this long
      this.OPEN_MIN = opts.openMin ?? 3; // fingers extended to count as a CLEAR open hand
      this.lastDefinite = null; // last unambiguous hand: "open" | "fist" | null
      this.presentSince = null; // when the hand (re)appeared
      this.closes = []; // timestamps of recent OPEN→FIST transitions
    }
    reset() {
      this.lastDefinite = null;
      this.presentSince = null;
      this.closes = [];
    }
    // present: is a hand visible. up: # of extended fingers (0-4). now: ms.
    // -> true once per double-clench. A clench = a CLEARLY OPEN hand (>=OPEN_MIN
    // fingers) becoming a FIST (0 fingers). The 1-2 finger in-between is treated
    // as NEUTRAL and leaves the last definite state unchanged — so moving a fist
    // around (fist↔partial jitter from noisy tracking) never fakes a clench, and
    // neither does entering the frame already fisted. Also ignored until the hand
    // has been present SETTLE ms (skips the noisy entry period).
    update(present, up, now) {
      if (!present) {
        this.reset();
        return false;
      }
      if (this.presentSince == null) this.presentSince = now;
      const settled = now - this.presentSince >= this.SETTLE;
      const state = up === 0 ? "fist" : up >= this.OPEN_MIN ? "open" : "other";
      let closed = false;
      if (state === "open") {
        this.lastDefinite = "open";
      } else if (state === "fist") {
        closed = settled && this.lastDefinite === "open"; // real open→fist clench
        this.lastDefinite = "fist";
      } // "other": leave lastDefinite unchanged (neutral)
      if (closed && (!this.closes.length || now - this.closes[this.closes.length - 1] >= this.MIN_GAP)) {
        this.closes.push(now);
      }
      while (this.closes.length && now - this.closes[0] > this.WINDOW) this.closes.shift();
      if (this.closes.length >= 2) {
        this.closes = []; // consume; require two fresh clenches to fire again
        return true;
      }
      return false;
    }
  }

  // Undo/redo over opaque board STATES (each is a Strokes.snapshot()). `commit`
  // records a new state (and clears the redo branch, like every editor); `undoTo`
  // / `redoTo` walk the history and return the state to restore, or null at an
  // end. Capped so a long session can't grow without bound.
  class UndoHistory {
    constructor(opts = {}) {
      this.max = opts.max ?? 60;
      this.past = [];
      this.future = [];
      this.current = null;
    }
    init(state) {
      this.current = state;
      this.past = [];
      this.future = [];
    }
    commit(state) {
      if (this.current !== null) {
        this.past.push(this.current);
        if (this.past.length > this.max) this.past.shift();
      }
      this.current = state;
      this.future = [];
    }
    canUndo() {
      return this.past.length > 0;
    }
    canRedo() {
      return this.future.length > 0;
    }
    undoTo() {
      if (!this.past.length) return null;
      this.future.push(this.current);
      this.current = this.past.pop();
      return this.current;
    }
    redoTo() {
      if (!this.future.length) return null;
      this.past.push(this.current);
      this.current = this.future.pop();
      return this.current;
    }
  }

  // "Shaken wildly?" — many horizontal direction REVERSALS plus a lot of total
  // travel across a short window of recent points → a deliberate shake (used to
  // cancel a drag). A straight or gently curved drag has few reversals, so it
  // won't trip. Points are {x,y} (timestamps handled by the caller's windowing).
  function isShake(pts, opts = {}) {
    const MIN = opts.minReversals ?? 4;
    const TRAVEL = opts.travel ?? 0.6;
    const EPS = opts.eps ?? 0.01;
    if (!pts || pts.length < 6) return false;
    let reversals = 0;
    let travel = 0;
    let lastDx = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      travel += Math.hypot(dx, dy);
      if (Math.abs(dx) > EPS) {
        if (dx * lastDx < 0) reversals++;
        lastDx = dx;
      }
    }
    return reversals >= MIN && travel > TRAVEL;
  }

  // Compound motion gesture: a qualifying pose (fist) held while the hand
  // SWIPES fast + far horizontally → fires once (used for "clear all"). The
  // velocity+distance gate is what separates a deliberate wipe from a slow
  // local erase, so it doesn't fire during normal use.
  class SwipeDetector {
    constructor(opts = {}) {
      this.DIST = opts.dist ?? 0.45; // horizontal travel (fraction of width)
      this.MS = opts.ms ?? 500; // ...within this window (fast)
      this.hist = [];
      this.fired = false;
    }
    reset() {
      this.hist = [];
      this.fired = false;
    }
    // active: pose held this frame. point: {x,y} display space. now: ms.
    // -> true exactly once when a qualifying swipe completes.
    update(active, point, now) {
      if (!active || !point) {
        this.reset();
        return false;
      }
      this.hist.push({ x: point.x, y: point.y, t: now });
      while (this.hist.length && now - this.hist[0].t > this.MS) this.hist.shift();
      if (this.fired || this.hist.length < 3) return false;
      const a = this.hist[0];
      const b = this.hist[this.hist.length - 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) > this.DIST && Math.abs(dx) > 2 * Math.abs(dy)) {
        this.fired = true;
        return true;
      }
      return false;
    }
  }

  // ---- generic gesture controller -------------------------------------------
  // DATA-DRIVEN: takes a list of gesture DEFINITIONS (from the bindings config).
  // Each def is { name, priority, detect(features)->bool, anchor(features,mirror)
  // ->point, settled?(features)->bool, vote?, coast? }. The controller computes
  // shared hand `features` once, evaluates every def (majority-voted per def),
  // and the highest-priority active def wins. Adding/changing a gesture = editing
  // ONE def in bindings.js — no controller code changes. Pointer is One Euro
  // smoothed; a def with coast:true survives a brief hand loss.
  class GestureController {
    constructor(defs = [], opts = {}) {
      this.defs = defs.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      // Optional injected curl classifier (landmarks -> gesture name|null), e.g. a
      // Fingerpose estimator. Kept OUT of the engine so it stays library-free and
      // Node-testable; the browser passes one in, tests don't (geometry fallback).
      this.curlClassifier = opts.curlClassifier || null;
      this.current = null; // winning def (or null)
      this.gesture = "none";
      this.penDown = false;
      this.pending = 0;
      this.gPinch = false; // generic thumb-to-any-fingertip pinch (hysteresis)
      this.gPending = 0;
      this.ratio = null;
      this.lastSpread = null;
      this.DOWN_T = opts.downT ?? 0.4;
      this.UP_T = opts.upT ?? 0.5; // release once the pinch opens past this (was 0.6 — too sticky)
      this.RATIO_A = opts.ratioA ?? 0.5;
      this.DEBOUNCE = opts.debounce ?? 2;
      this.RISE_EPS = opts.riseEps ?? 0.02;
      this.VOTE_WINDOW = opts.voteWindow ?? 5;
      this.VOTE_ENTER = opts.voteEnter ?? 3;
      this.VOTE_STAY = opts.voteStay ?? 2;
      this.GRACE = opts.graceMs ?? 180; // coast this long through a tracking flicker, then release
      this.votes = {};
      for (const d of this.defs) this.votes[d.name] = { window: [], state: false };
      this.lastSeen = null;
      this.lastPoint = null;
      const mc = opts.minCutoff ?? 1.2;
      const bt = opts.beta ?? 0.03;
      this.fx = new OneEuro({ minCutoff: mc, beta: bt });
      this.fy = new OneEuro({ minCutoff: mc, beta: bt });
    }

    // Shared per-frame hand features the gesture predicates read.
    _features(lm) {
      const thumb = lm[4];
      const index = lm[8];
      const wrist = lm[0];
      const midMcp = lm[9];
      const handSize = Math.hypot(midMcp.x - wrist.x, midMcp.y - wrist.y) || 1e-3;
      const raw = Math.hypot(thumb.x - index.x, thumb.y - index.y) / handSize;
      const oldRatio = this.ratio;
      this.ratio = this.ratio == null ? raw : this.RATIO_A * raw + (1 - this.RATIO_A) * this.ratio;
      const rising = oldRatio == null ? 0 : this.ratio - oldRatio;
      const five = fivePinch(lm);
      // Spread velocity: rises ONLY when the fingers actually open (release),
      // NOT when the hand moves in depth (spread is size-normalized, so a depth
      // move scales tips and hand together and cancels). Lets the grab freeze the
      // moment a five-pinch starts releasing, so opening the hand can't perturb
      // the scale you just set.
      const oldSpread = this.lastSpread;
      this.lastSpread = five.spread;
      const spreadRising = oldSpread == null ? 0 : five.spread - oldSpread;
      // A five-finger cluster (or anything near it) is NOT a single-finger pinch.
      // The dead zone (spread < 0.75, just above the five-pinch threshold of 0.6)
      // means that while every finger is hugging the thumb — including the moment
      // a five-pinch is forming or releasing at any angle — draw/erase stay OFF.
      // Because spread is the WORST finger's distance to the thumb, curling your
      // other fingers during a normal draw keeps this large, so the pen holds.
      const clustered = five.spread < 0.75;

      // pinch penDown (hysteresis + debounce); a cluster suppresses it.
      const wantDown = clustered ? false : this.penDown ? this.ratio <= this.UP_T : this.ratio < this.DOWN_T;
      if (wantDown !== this.penDown) {
        if (++this.pending >= this.DEBOUNCE) {
          this.penDown = wantDown;
          this.pending = 0;
        }
      } else {
        this.pending = 0;
      }
      if (clustered) this.penDown = false;

      // VR-style pinch DICTIONARY: thumb tip to each fingertip. Whichever finger
      // is closest AND close enough is the active pinch (index / middle / ...).
      // Same hysteresis+debounce on the MIN distance so it doesn't flicker; a
      // five-pinch suppresses it. This is what lets one deliberate pose (pinch)
      // drive several distinct actions by which finger touches the thumb.
      const tips = { index: index, middle: lm[12], ring: lm[16], pinky: lm[20] };
      const pd = {};
      let which = "index";
      for (const k in tips) {
        pd[k] = Math.hypot(thumb.x - tips[k].x, thumb.y - tips[k].y) / handSize;
        if (pd[k] < pd[which]) which = k;
      }
      const minD = pd[which];
      const wantP = clustered ? false : this.gPinch ? minD <= this.UP_T : minD < this.DOWN_T;
      if (wantP !== this.gPinch) {
        if (++this.gPending >= this.DEBOUNCE) {
          this.gPinch = wantP;
          this.gPending = 0;
        }
      } else {
        this.gPending = 0;
      }
      if (clustered) this.gPinch = false;
      const pinch = { on: this.gPinch, which, tip: { x: tips[which].x, y: tips[which].y } };

      return {
        ratio: this.ratio,
        rising,
        spreadRising,
        penDown: this.penDown,
        pinch,
        fingers: fingerExtended(lm),
        five,
        indexTip: { x: index.x, y: index.y },
        middleTip: { x: lm[12].x, y: lm[12].y },
        thumbTip: { x: thumb.x, y: thumb.y }, // stays put during a fist → a stable eraser pointer
        thumbOut: thumbExtended(lm, 0.7), // thumb abducted (out) vs tucked in — for fist variants
        // Injected curl-classifier label (e.g. Fingerpose): a gesture def can read
        // `f.fp` when `f.fpOn`, else fall back to its own geometry.
        fpOn: !!this.curlClassifier,
        fp: this.curlClassifier ? this.curlClassifier(lm) : null,
        // palm centre (wrist + 4 knuckles): stable even in a fist, so a fist-based
        // action (e.g. erase) has a predictable anchor, not a jittery curled tip.
        palm: {
          x: (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5,
          y: (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5,
        },
        RISE_EPS: this.RISE_EPS,
      };
    }

    // landmarks: 21 {x,y,z} or null. (2nd arg ignored — kept for call signature.)
    // mirror: selfie display. now: ms. -> { gesture, changed, point, present, settled, ratio }
    update(landmarks, _ignored, mirror, now) {
      if (!landmarks || landmarks.length < 21) {
        if (this.current && this.current.coast && this.lastSeen != null && now != null && now - this.lastSeen < this.GRACE) {
          // Keep the gesture ALIVE across a brief tracking loss so a 1-2 frame
          // flicker doesn't break a stroke — but settled:false, so we do NOT
          // append ink or show an active pen while blind. Otherwise releasing by
          // pulling the hand away (which drops tracking) reads as "still drawing"
          // for the whole grace window: the pen appears stuck down.
          return { gesture: this.gesture, changed: false, point: this.lastPoint, present: false, settled: false, coasting: true };
        }
        const wasActive = this.gesture !== "none";
        this.current = null;
        this.gesture = "none";
        this.penDown = false;
        this.pending = 0;
        this.gPinch = false;
        this.gPending = 0;
        this.ratio = null;
        this.lastSpread = null;
        this.lastPoint = null;
        for (const k in this.votes) this.votes[k] = { window: [], state: false };
        this.fx.reset();
        this.fy.reset();
        return { gesture: "none", changed: wasActive, point: null, present: false, settled: false };
      }

      const feat = this._features(landmarks);
      let winner = null;
      for (const d of this.defs) {
        const raw = !!d.detect(feat);
        let on;
        if (d.vote === false) {
          on = raw;
        } else {
          const v = this.votes[d.name];
          v.window.push(raw);
          if (v.window.length > this.VOTE_WINDOW) v.window.shift();
          const count = v.window.reduce((a, b) => a + (b ? 1 : 0), 0);
          v.state = v.state ? count >= this.VOTE_STAY : count >= this.VOTE_ENTER;
          on = v.state;
        }
        if (on && !winner) winner = d; // defs are priority-sorted; first wins
      }

      const prev = this.gesture;
      this.current = winner;
      this.gesture = winner ? winner.name : "none";
      const changed = this.gesture !== prev;
      if (changed) {
        this.fx.reset();
        this.fy.reset();
      }
      const a =
        winner && winner.anchor
          ? winner.anchor(feat, mirror)
          : { x: mirror ? 1 - feat.indexTip.x : feat.indexTip.x, y: feat.indexTip.y };
      const point = { x: this.fx.filter(a.x, now), y: this.fy.filter(a.y, now) };
      const settled = winner && winner.settled ? !!winner.settled(feat) : false;
      this.lastSeen = now;
      this.lastPoint = point;
      return { gesture: this.gesture, changed, point, present: true, settled, ratio: feat.ratio, fp: feat.fp };
    }
  }

  // ---- drawing model --------------------------------------------------------
  // ---- geometry helpers (for shape recognition) ----------------------------
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // Median of three scalars — the core of the draw de-spiker (a single-frame
  // outlier is discarded, a real trend passes through unchanged).
  const med3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  // Perpendicular distance of p from the infinite line a-b.
  function perp(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1e-9;
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
  }
  // Ramer–Douglas–Peucker: simplify a polyline to its dominant vertices.
  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    let dmax = 0;
    let idx = 0;
    const a = pts[0];
    const b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perp(pts[i], a, b);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    if (dmax > eps) {
      const left = rdp(pts.slice(0, idx + 1), eps);
      const right = rdp(pts.slice(idx), eps);
      return left.slice(0, -1).concat(right);
    }
    return [a, b];
  }
  // Corner vertices of a CLOSED curve. RDP needs a non-degenerate baseline, so
  // split the loop at the point farthest from the start, then RDP each half.
  function closedVertices(pts, eps) {
    let far = 0;
    let fd = -1;
    for (let i = 1; i < pts.length; i++) {
      const d = dist(pts[i], pts[0]);
      if (d > fd) {
        fd = d;
        far = i;
      }
    }
    const first = rdp(pts.slice(0, far + 1), eps);
    const second = rdp(pts.slice(far), eps);
    return first.slice(0, -1).concat(second.slice(0, -1));
  }
  // Drop vertices that are nearly collinear with their neighbours — removes the
  // spurious mid-edge vertex closedVertices can leave at its split point.
  function simplifyClosed(verts, eps) {
    let out = verts;
    let changed = true;
    while (changed && out.length > 3) {
      changed = false;
      for (let i = 0; i < out.length; i++) {
        const prev = out[(i - 1 + out.length) % out.length];
        const next = out[(i + 1) % out.length];
        if (perp(out[i], prev, next) < eps) {
          out = out.filter((_, j) => j !== i);
          changed = true;
          break;
        }
      }
    }
    return out;
  }

  // Order an unordered point cloud into loop order by sorting around the
  // centroid. Valid for CONVEX shapes (circle/rectangle/triangle), which lets
  // multi-stroke drawings be recognized with the same single-stroke recognizer.
  function angleSort(pts) {
    if (pts.length < 3) return pts.slice();
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  }

  // Recognize a clean shape from a freehand stroke. Returns a shape item or null
  // (null = "not confidently a shape", so the freehand stroke is kept as-is —
  // the intent gate that avoids unnecessary correction). Shapes are chosen by
  // smallest normalized residual (fit error / bbox diagonal); ACCEPT tunes how
  // eager the correction is. Circles are detected by angular coverage, NOT
  // endpoint closure, so under-drawn (open) circles still snap.
  // aspect = canvasWidth/canvasHeight so circles come out round, not elliptical.
  function recognizeShape(points, aspect = 1, opts = {}) {
    const ACCEPT = opts.accept ?? 0.06; // max residual/diag to correct
    const multi = !!opts.multi; // combined multi-stroke cloud (already a loop)
    if (!points || points.length < 6) return null;
    const iso = points.map((p) => ({ x: p.x * aspect, y: p.y }));
    const n = iso.length;

    let minx = Infinity;
    let maxx = -Infinity;
    let miny = Infinity;
    let maxy = -Infinity;
    for (const p of iso) {
      if (p.x < minx) minx = p.x;
      if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y;
      if (p.y > maxy) maxy = p.y;
    }
    const diag = Math.hypot(maxx - minx, maxy - miny);
    if (diag < 0.04) return null; // too tiny to bother
    const toNorm = (p) => ({ x: p.x / aspect, y: p.y });

    // LINE — open and straight.
    const segLen = dist(iso[0], iso[n - 1]);
    const closedD = segLen / diag; // ~0 = endpoints meet (loop), ~1 = open span
    const lineRes = perpMax(iso) / (segLen || 1e-9);
    // A line only from a single ordered stroke (a combined cloud isn't a line).
    if (!multi && closedD > 0.35 && lineRes < ACCEPT) {
      return { kind: "line", a: { ...points[0] }, b: { ...points[n - 1] }, confidence: 1 - lineRes / ACCEPT };
    }

    // Angular coverage around the centroid (how much of a full loop is drawn).
    const cx = iso.reduce((s, p) => s + p.x, 0) / n;
    const cy = iso.reduce((s, p) => s + p.y, 0) / n;
    let cov = 0;
    let prev = null;
    for (const p of iso) {
      const ang = Math.atan2(p.y - cy, p.x - cx);
      if (prev != null) {
        let d = ang - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        cov += d;
      }
      prev = ang;
    }
    cov = Math.abs(cov);

    // Polygon fit (closed-curve aware), with collinear vertices removed.
    const verts = simplifyClosed(closedVertices(iso, 0.05 * diag), 0.04 * diag);
    const corners = verts.length;
    const polyRes = polygonResidual(iso, verts) / diag;

    // Does the path reach the corners of its bounding box? A rectangle does
    // (even with rounded, smoothed corners); a circle stays ~0.15·diag away.
    // This is what tells a hand-drawn (rounded) rectangle from an ellipse.
    const bboxCorners = [
      { x: minx, y: miny },
      { x: maxx, y: miny },
      { x: maxx, y: maxy },
      { x: minx, y: maxy },
    ];
    let cornerFill = 0;
    for (const cpt of bboxCorners) {
      let m = Infinity;
      for (const p of iso) m = Math.min(m, dist(p, cpt));
      cornerFill = Math.max(cornerFill, m);
    }
    cornerFill /= diag;
    const fillsBox = cornerFill < 0.11; // reaches all 4 bbox corners => rectangle

    // AXIS-ALIGNED RECTANGLE — a closed loop that fills its bounding box. Caught
    // before the circle test so rounded-corner rectangles don't read as ellipses.
    if (fillsBox && cov > 4.4 && (multi || closedD < 0.45) && edgesCovered(iso, bboxCorners, diag)) {
      return {
        kind: "poly",
        closed: true,
        pts: bboxCorners.map(toNorm),
        confidence: 1 - cornerFill / 0.11,
      };
    }

    // ELLIPSE (incl. circle) — fit an ellipse from the bbox and test how well the
    // points lie on it (normalize each point by the bbox half-extents; a true
    // ellipse gives normalized radius ≈ 1). This preserves OVALS (rx≠ry) instead
    // of forcing everything round, and rejects stars/pentagons (high residual).
    // cov > 5.0 (~286°) so an open C-arc doesn't snap to a full oval.
    const bcx = (minx + maxx) / 2;
    const bcy = (miny + maxy) / 2;
    const rxI = Math.max((maxx - minx) / 2, 1e-6);
    const ryI = Math.max((maxy - miny) / 2, 1e-6);
    let ellVar = 0;
    for (const p of iso) {
      const nr = Math.hypot((p.x - bcx) / rxI, (p.y - bcy) / ryI);
      ellVar += (nr - 1) ** 2;
    }
    const ellipseErr = Math.sqrt(ellVar / n);
    if (!fillsBox && ellipseErr < 0.14 && cov > 5.0) {
      return {
        kind: "ellipse",
        cx: bcx / aspect,
        cy: bcy,
        rx: rxI / aspect,
        ry: ryI,
        confidence: 1 - ellipseErr / 0.14,
      };
    }

    // TRIANGLE / rotated RECTANGLE — closed loop simplifying to 3–4 sharp
    // corners, with a point along every edge (so partial figures don't snap).
    if ((corners === 3 || corners === 4) && polyRes < ACCEPT && (multi || closedD < 0.45) && edgesCovered(iso, verts, diag)) {
      const conf = 1 - polyRes / ACCEPT;
      if (corners === 4 && axisAligned(verts, diag)) {
        return {
          kind: "poly",
          closed: true,
          pts: [
            { x: minx, y: miny },
            { x: maxx, y: miny },
            { x: maxx, y: maxy },
            { x: minx, y: maxy },
          ].map(toNorm),
          confidence: conf,
        };
      }
      return { kind: "poly", closed: true, pts: verts.map(toNorm), confidence: conf };
    }
    return null;
  }
  function perpMax(pts) {
    let m = 0;
    const a = pts[0];
    const b = pts[pts.length - 1];
    for (const p of pts) m = Math.max(m, perp(p, a, b));
    return m;
  }
  // Mean residual of the original points to the nearest polygon edge.
  function polygonResidual(pts, verts) {
    if (verts.length < 2) return Infinity;
    let sum = 0;
    for (const p of pts) {
      let best = Infinity;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        best = Math.min(best, segDist(p, a, b));
      }
      sum += best;
    }
    return sum / pts.length;
  }
  function sampleLine(a, b, k = 6) {
    return Array.from({ length: k }, (_, i) => {
      const t = i / (k - 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    });
  }
  // Every edge of the candidate polygon has a point near its midpoint — i.e. the
  // shape is actually complete, not 3 sides of a rectangle or 2 of a triangle.
  function edgesCovered(pts, verts, diag) {
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      let m = Infinity;
      for (const p of pts) m = Math.min(m, dist(p, mid));
      if (m > 0.2 * diag) return false;
    }
    return true;
  }
  function segDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1e-9;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  // Scale + rotate a single normalized point about `center`. Normalized coords
  // are NOT isotropic (the canvas is wider than it is tall), so a raw rotation
  // would skew. We work in aspect-corrected space (x·aspect), where a rotation
  // is a TRUE rotation, then divide x back. Pure — unit-tested.
  function transformPoint(p, scale, rotateRad, center, aspect = 1) {
    const cx = center.x * aspect;
    const cy = center.y;
    const dx = p.x * aspect - cx;
    const dy = p.y - cy;
    const cos = Math.cos(rotateRad);
    const sin = Math.sin(rotateRad);
    const rx = (dx * cos - dy * sin) * scale;
    const ry = (dx * sin + dy * cos) * scale;
    return { x: (cx + rx) / aspect, y: cy + ry };
  }
  // Scale + rotation implied by two hands' pinch points moving between frames.
  // vec = B - A; scale = |vec_now|/|vec_prev|, rotate = Δatan2(vec), center =
  // midpoint of the current pinch points. Pure — unit-tested.
  function twoHandDelta(prevA, prevB, curA, curB) {
    const pv = { x: prevB.x - prevA.x, y: prevB.y - prevA.y };
    const cv = { x: curB.x - curA.x, y: curB.y - curA.y };
    const prevLen = Math.hypot(pv.x, pv.y) || 1e-9;
    const scale = Math.hypot(cv.x, cv.y) / prevLen;
    const rotate = Math.atan2(cv.y, cv.x) - Math.atan2(pv.y, pv.x);
    const center = { x: (curA.x + curB.x) / 2, y: (curA.y + curB.y) / 2 };
    return { scale, rotate, center };
  }
  // Absolute single-hand transform from a grab reference to the current frame.
  // grab/cur: { size, angle, pos:{x,y} }. size = apparent hand size (depth proxy,
  // bigger = closer = larger scale); angle = wrist roll (rotate); pos = hand
  // position (pan). Returns the TOTAL transform since grab. Pure — unit-tested.
  function depthTransform(grab, cur, opts = {}) {
    const gain = opts.gain ?? 1.8; // amplify depth so a small move gives big range
    const rotGain = opts.rotGain ?? 1; // amplify wrist-roll → more rotation range
    // Reversed depth: hand CLOSER (bigger) = zoom OUT, hand FURTHER = zoom IN.
    let scale = Math.pow((grab.size || 1e-6) / (cur.size || 1e-6), gain);
    scale = Math.max(0.1, Math.min(10, scale));
    let rotate = cur.angle - grab.angle;
    while (rotate > Math.PI) rotate -= 2 * Math.PI;
    while (rotate < -Math.PI) rotate += 2 * Math.PI;
    return { scale, rotate: rotate * rotGain, pan: { x: cur.pos.x - grab.pos.x, y: cur.pos.y - grab.pos.y } };
  }
  function axisAligned(verts, diag) {
    // Every vertex sits near a corner of the bounding box.
    let minx = Infinity;
    let maxx = -Infinity;
    let miny = Infinity;
    let maxy = -Infinity;
    for (const v of verts) {
      minx = Math.min(minx, v.x);
      maxx = Math.max(maxx, v.x);
      miny = Math.min(miny, v.y);
      maxy = Math.max(maxy, v.y);
    }
    const corners = [
      { x: minx, y: miny },
      { x: maxx, y: miny },
      { x: maxx, y: maxy },
      { x: minx, y: maxy },
    ];
    return verts.every((v) => corners.some((c) => dist(v, c) < 0.18 * diag));
  }

  // ---- drawing model: strokes AND recognized shapes -------------------------
  // Items: {kind:'stroke', points} | {kind:'line', a,b} | {kind:'ellipse',
  // cx,cy,rx,ry} | {kind:'poly', pts, closed}. All carry color+size. Points are
  // normalized (0..1); render scales by canvas W/H.
  class Strokes {
    constructor(opts = {}) {
      this.list = [];
      this.current = null;
      this.GROUP_MS = opts.groupMs ?? 2500; // window to combine multi-stroke shapes
    }
    clear() {
      this.list = [];
      this.current = null;
    }
    // Deep copy of the items (for an absolute transform from a fixed snapshot).
    snapshot() {
      return this.list.map((it) => structuredClone(it));
    }
    restore(snap) {
      this.list = snap.map((it) => structuredClone(it));
    }
    begin(pt, color, size) {
      this.current = { kind: "stroke", color, size, points: [{ x: pt.x, y: pt.y }] };
      this.list.push(this.current);
    }
    extend(pt) {
      if (!this.current) return;
      const pts = this.current.points;
      const n = pts.length;
      // De-spike: replace the PREVIOUS point with the median-of-3 of its left
      // neighbour, itself, and this incoming point. A single-frame gesture-
      // detection glitch (a tiny mistroke that darts off the movement line and
      // returns) is pulled back onto the line; smooth motion and real corners
      // (where the trend continues) are left untouched. Retroactive — it fixes
      // the point drawn one frame ago as the next arrives, so there's no lag.
      if (n >= 2) {
        const a = pts[n - 2];
        const b = pts[n - 1];
        pts[n - 1] = { x: med3(a.x, b.x, pt.x), y: med3(a.y, b.y, pt.y) };
      }
      pts.push({ x: pt.x, y: pt.y });
    }
    // Discard the in-progress stroke entirely (used by shake-to-escape).
    cancelCurrent() {
      if (!this.current) return;
      const idx = this.list.indexOf(this.current);
      if (idx !== -1) this.list.splice(idx, 1);
      this.current = null;
    }
    // Finish the current stroke. If assist is on and it fits a shape well, the
    // freehand stroke is replaced by the clean shape. If a single stroke doesn't
    // fit, recent strokes (drawn within GROUP_MS) are combined and re-checked —
    // so a box drawn as 4 strokes or a triangle as 3 still snaps.
    end(assist = false, aspect = 1, now = 0) {
      const s = this.current;
      this.current = null;
      if (!assist || !s || s.kind !== "stroke") return null;
      s.t = now;

      // 1) The just-finished stroke on its own.
      const single = recognizeShape(s.points, aspect);
      if (single) {
        const idx = this.list.indexOf(s);
        if (idx !== -1) this.list[idx] = { ...single, color: s.color, size: s.size, t: now };
        // fall through: this line/shape may also complete a multi-stroke figure
      }

      // 2) Combine recent primitives — strokes AND single lines (a box drawn as
      // 4 strokes becomes 4 lines first) — into one convex, angle-sorted cloud.
      const recent = (it) => (it.kind === "stroke" || it.kind === "line") && now - (it.t || 0) <= this.GROUP_MS;
      const group = this.list.filter(recent);
      if (group.length >= 2) {
        const cloud = group.flatMap((it) => (it.kind === "line" ? sampleLine(it.a, it.b) : it.points));
        const shape = recognizeShape(angleSort(cloud), aspect, { multi: true });
        if (shape && shape.kind !== "line") {
          this.list = this.list.filter((it) => !group.includes(it));
          this.list.push({ ...shape, color: s.color, size: s.size, t: now });
          return this.list[this.list.length - 1];
        }
      }
      return single ? this.list.find((it) => it.t === now) : null;
    }
    // Index of the topmost item within `tol` of p, or -1.
    hitTest(p, tol) {
      for (let i = this.list.length - 1; i >= 0; i--) {
        if (this._distTo(this.list[i], p) <= tol) return i;
      }
      return -1;
    }
    _distTo(it, p) {
      if (it.kind === "line") return segDist(p, it.a, it.b);
      if (it.kind === "ellipse") {
        // near the outline, or inside
        const dx = (p.x - it.cx) / (it.rx || 1e-9);
        const dy = (p.y - it.cy) / (it.ry || 1e-9);
        const r = Math.hypot(dx, dy);
        if (r <= 1) return 0;
        return (r - 1) * Math.min(it.rx, it.ry);
      }
      const pts = it.kind === "poly" ? it.pts : it.points;
      let best = Infinity;
      const m = it.kind === "poly" && it.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < m; i++) best = Math.min(best, segDist(p, pts[i], pts[(i + 1) % pts.length]));
      return best;
    }
    translate(i, dx, dy) {
      const it = this.list[i];
      if (!it) return;
      if (it.kind === "line") {
        it.a = { x: it.a.x + dx, y: it.a.y + dy };
        it.b = { x: it.b.x + dx, y: it.b.y + dy };
      } else if (it.kind === "ellipse") {
        it.cx += dx;
        it.cy += dy;
      } else {
        const arr = it.kind === "poly" ? it.pts : it.points;
        for (const pt of arr) {
          pt.x += dx;
          pt.y += dy;
        }
      }
    }
    // Scale + rotate EVERY item about `center` (aspect-corrected so rotation is
    // true, not skewed by the wide canvas). Drives the two-hand transform
    // gesture. Ellipses stay axis-aligned: only their centre moves and their
    // radii scale (rotating the axes themselves is intentionally ignored).
    // Scale+rotate one item about `center` (aspect-corrected so rotation is true).
    _xform(it, scale, rotateRad, center, aspect) {
      // Scale the stroke WIDTH with the zoom too, so lines thicken/thin with the
      // drawing instead of staying a fixed pixel count. Clamped so extreme zooms
      // don't make strokes vanish or explode. (Applied from a snapshot each frame,
      // so it's absolute — no runaway accumulation.)
      if (typeof it.size === "number") it.size = Math.max(0.5, Math.min(80, it.size * scale));
      const tp = (p) => transformPoint(p, scale, rotateRad, center, aspect);
      if (it.kind === "line") {
        it.a = tp(it.a);
        it.b = tp(it.b);
      } else if (it.kind === "ellipse") {
        const c = tp({ x: it.cx, y: it.cy });
        it.cx = c.x;
        it.cy = c.y;
        it.rx *= scale;
        it.ry *= scale;
      } else {
        const arr = it.kind === "poly" ? it.pts : it.points;
        for (let i = 0; i < arr.length; i++) arr[i] = tp(arr[i]);
      }
    }
    transformAll(scale, rotateRad, center, aspect = 1) {
      for (const it of this.list) this._xform(it, scale, rotateRad, center, aspect);
    }
    // Scale+rotate a single item (for single-hand object transform).
    transformItem(i, scale, rotateRad, center, aspect = 1) {
      if (this.list[i]) this._xform(this.list[i], scale, rotateRad, center, aspect);
    }
    // Bounding-box centre of item i (the natural pivot to scale/rotate it about).
    itemCenter(i) {
      const it = this.list[i];
      if (!it) return null;
      if (it.kind === "ellipse") return { x: it.cx, y: it.cy };
      const pts = it.kind === "line" ? [it.a, it.b] : it.kind === "poly" ? it.pts : it.points;
      let mnx = Infinity;
      let mxx = -Infinity;
      let mny = Infinity;
      let mxy = -Infinity;
      for (const p of pts) {
        mnx = Math.min(mnx, p.x);
        mxx = Math.max(mxx, p.x);
        mny = Math.min(mny, p.y);
        mxy = Math.max(mxy, p.y);
      }
      return { x: (mnx + mxx) / 2, y: (mny + mxy) / 2 };
    }
    // Bounding box of ALL items in normalized canvas coords (may fall outside
    // 0..1 once strokes are panned/zoomed off the visible frame). Null if empty.
    // Drives the minimap's "where is everything" overview.
    bounds() {
      let mnx = Infinity;
      let mny = Infinity;
      let mxx = -Infinity;
      let mxy = -Infinity;
      const acc = (x, y) => {
        mnx = Math.min(mnx, x);
        mny = Math.min(mny, y);
        mxx = Math.max(mxx, x);
        mxy = Math.max(mxy, y);
      };
      for (const it of this.list) {
        if (it.kind === "line") {
          acc(it.a.x, it.a.y);
          acc(it.b.x, it.b.y);
        } else if (it.kind === "ellipse") {
          acc(it.cx - it.rx, it.cy - it.ry);
          acc(it.cx + it.rx, it.cy + it.ry);
        } else {
          for (const p of it.kind === "poly" ? it.pts : it.points) acc(p.x, p.y);
        }
      }
      return mnx === Infinity ? null : { minx: mnx, miny: mny, maxx: mxx, maxy: mxy };
    }
    // Pan every item (two-hand "move the whole canvas").
    translateAll(dx, dy) {
      for (let i = 0; i < this.list.length; i++) this.translate(i, dx, dy);
    }
    // Move several items together (bulk drag of a selection).
    translateItems(indices, dx, dy) {
      for (const i of indices) this.translate(i, dx, dy);
    }
    // Bounding box of one item (normalized), or null.
    _itemBounds(i) {
      const it = this.list[i];
      if (!it) return null;
      if (it.kind === "ellipse") return { minx: it.cx - it.rx, miny: it.cy - it.ry, maxx: it.cx + it.rx, maxy: it.cy + it.ry };
      const pts = it.kind === "line" ? [it.a, it.b] : it.kind === "poly" ? it.pts : it.points;
      let mnx = Infinity;
      let mny = Infinity;
      let mxx = -Infinity;
      let mxy = -Infinity;
      for (const p of pts) {
        mnx = Math.min(mnx, p.x);
        mny = Math.min(mny, p.y);
        mxx = Math.max(mxx, p.x);
        mxy = Math.max(mxy, p.y);
      }
      return mnx === Infinity ? null : { minx: mnx, miny: mny, maxx: mxx, maxy: mxy };
    }
    // Indices of items whose CENTRE falls inside the rectangle (marquee select).
    selectInRect(x0, y0, x1, y1) {
      const lx = Math.min(x0, x1);
      const hx = Math.max(x0, x1);
      const ly = Math.min(y0, y1);
      const hy = Math.max(y0, y1);
      const out = [];
      for (let i = 0; i < this.list.length; i++) {
        const c = this.itemCenter(i);
        if (c && c.x >= lx && c.x <= hx && c.y >= ly && c.y <= hy) out.push(i);
      }
      return out;
    }
    // Bounding box of a set of items (the selection outline), or null.
    itemsBounds(indices) {
      let mnx = Infinity;
      let mny = Infinity;
      let mxx = -Infinity;
      let mxy = -Infinity;
      for (const i of indices) {
        const b = this._itemBounds(i);
        if (!b) continue;
        mnx = Math.min(mnx, b.minx);
        mny = Math.min(mny, b.miny);
        mxx = Math.max(mxx, b.maxx);
        mxy = Math.max(mxy, b.maxy);
      }
      return mnx === Infinity ? null : { minx: mnx, miny: mny, maxx: mxx, maxy: mxy };
    }
    // Remove points within r of p; splits strokes, deletes shapes it touches.
    // Returns true if anything was actually removed (so callers can gate undo).
    eraseAt(p, r) {
      const r2 = r * r;
      const next = [];
      let removed = false;
      for (const it of this.list) {
        if (it.kind !== "stroke") {
          if (this._distTo(it, p) > r) next.push(it);
          else removed = true; // a shape was deleted
          continue;
        }
        const before = it.points.length;
        let seg = null;
        let kept = 0;
        for (const pt of it.points) {
          const dx = pt.x - p.x;
          const dy = pt.y - p.y;
          if (dx * dx + dy * dy <= r2) {
            if (seg) next.push(seg);
            seg = null;
          } else {
            if (!seg) seg = { kind: "stroke", color: it.color, size: it.size, points: [] };
            seg.points.push(pt);
            kept++;
          }
        }
        if (seg) next.push(seg);
        if (kept !== before) removed = true;
      }
      this.list = next;
      this.current = null;
      return removed;
    }
    render(ctx, W, H, highlightIndex = -1) {
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      this.list.forEach((it, i) => {
        ctx.strokeStyle = it.color;
        ctx.lineWidth = it.size;
        ctx.beginPath();
        if (it.kind === "line") {
          ctx.moveTo(it.a.x * W, it.a.y * H);
          ctx.lineTo(it.b.x * W, it.b.y * H);
        } else if (it.kind === "ellipse") {
          ctx.ellipse(it.cx * W, it.cy * H, it.rx * W, it.ry * H, 0, 0, Math.PI * 2);
        } else if (it.kind === "poly") {
          it.pts.forEach((pt, k) => (k === 0 ? ctx.moveTo(pt.x * W, pt.y * H) : ctx.lineTo(pt.x * W, pt.y * H)));
          if (it.closed) ctx.closePath();
        } else {
          if (it.points.length === 0) return;
          const p0 = it.points[0];
          ctx.moveTo(p0.x * W, p0.y * H);
          for (let k = 1; k < it.points.length - 1; k++) {
            const a = it.points[k];
            const b = it.points[k + 1];
            ctx.quadraticCurveTo(a.x * W, a.y * H, ((a.x + b.x) / 2) * W, ((a.y + b.y) / 2) * H);
          }
          const last = it.points[it.points.length - 1];
          ctx.lineTo(last.x * W, last.y * H);
        }
        ctx.stroke();
        if (i === highlightIndex) {
          ctx.save();
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.lineWidth = it.size + 6;
          ctx.globalAlpha = 0.35;
          ctx.stroke();
          ctx.restore();
        }
      });
    }
  }

  const api = { GestureController, Strokes, OneEuro, SwipeDetector, FistClench, DoubleTap, UndoHistory, fivePinch, isFist, handOpenness, fingerExtended, thumbExtended, thumbDist, isShake, recognizeShape, rdp, transformPoint, twoHandDelta, depthTransform };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DrawMeEngine = api;
})(typeof window !== "undefined" ? window : null);
