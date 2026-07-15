// draw.me — $P point-cloud recognizer (template / by-example shapes).
// Simple primitives (circle/line/rect/triangle) are handled analytically in
// engine.js. This module recognizes shapes that have NO equation — arrows, a
// checkmark, an X, digits — by matching an air-drawn point cloud against stored
// templates. It is the $P recognizer (Vatavu, Anthony & Wobbrock, public
// domain): order-invariant and multi-stroke, which fits air-drawing where the
// pen never truly lifts and stroke order is unreliable.
// Points are {x,y} normalized 0..1 (the format used everywhere in draw.me); a
// multi-stroke shape is authored/passed as one concatenated array of points.
// Exposes window.DrawMeQ = { QRecognizer, resample, normalize }.
(function (root) {
  "use strict";

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ---- $P normalization -----------------------------------------------------
  // Total length of the concatenated polyline (used to space resampled points).
  function pathLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
    return d;
  }

  // Resample the cloud to exactly N equidistant points along its path. The cloud
  // is treated as one polyline (strokes already concatenated), so templates and
  // candidates are resampled identically — what makes the match order-invariant.
  function resample(points, n) {
    const pts = points.map((p) => ({ x: p.x, y: p.y }));
    const I = pathLength(pts) / (n - 1) || 1e-9; // spacing between samples
    let D = 0;
    const out = [{ x: pts[0].x, y: pts[0].y }];
    for (let i = 1; i < pts.length; i++) {
      const d = dist(pts[i - 1], pts[i]);
      if (D + d >= I) {
        const t = (I - D) / d;
        const q = {
          x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x),
          y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y),
        };
        out.push(q);
        pts.splice(i, 0, q); // continue measuring from the inserted point
        D = 0;
      } else {
        D += d;
      }
    }
    // Floating-point drift can leave us one short; pad with the last point.
    while (out.length < n) out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
    if (out.length > n) out.length = n;
    return out;
  }

  // Scale to a unit bounding box (uniform, aspect preserved: the larger side
  // becomes 1) then translate the centroid to the origin. After this two clouds
  // of the same shape at any size/position line up, so nearest-point distances
  // are comparable — i.e. recognition is scale- and translation-invariant.
  function scaleToUnit(pts) {
    let minx = Infinity;
    let maxx = -Infinity;
    let miny = Infinity;
    let maxy = -Infinity;
    for (const p of pts) {
      if (p.x < minx) minx = p.x;
      if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y;
      if (p.y > maxy) maxy = p.y;
    }
    const size = Math.max(maxx - minx, maxy - miny) || 1e-9;
    return pts.map((p) => ({ x: (p.x - minx) / size, y: (p.y - miny) / size }));
  }
  function translateToOrigin(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return pts.map((p) => ({ x: p.x - cx, y: p.y - cy }));
  }
  // Full $P normalization: resample -> scale to unit box -> centre on origin.
  function normalize(points, n) {
    return translateToOrigin(scaleToUnit(resample(points, n)));
  }

  // ---- $P greedy cloud matching ---------------------------------------------
  // One directional pass: walk pts from `start`, greedily pairing each with its
  // nearest still-unmatched template point, weighting earlier pairings more
  // (confident matches near the start dominate). Returns the weighted distance
  // sum; the weights over a full pass always total (n+1)/2.
  function cloudDistance(pts, tmpl, n, start) {
    const matched = new Array(n).fill(false);
    let sum = 0;
    let i = start;
    let done = 0;
    do {
      let min = Infinity;
      let index = -1;
      for (let j = 0; j < n; j++) {
        if (matched[j]) continue;
        const d = dist(pts[i], tmpl[j]);
        if (d < min) {
          min = d;
          index = j;
        }
      }
      matched[index] = true;
      const weight = 1 - ((i - start + n) % n) / n;
      sum += weight * min;
      i = (i + 1) % n;
      done++;
    } while (done < n);
    return sum;
  }

  // Greedy-Cloud-Match: try several starting offsets (step ≈ sqrt(n)) in both
  // directions and keep the smallest weighted cloud distance. This approximates
  // the optimal point-to-point assignment cheaply.
  function greedyCloudMatch(pts, tmpl, n) {
    const step = Math.max(1, Math.floor(Math.pow(n, 0.5)));
    let min = Infinity;
    for (let i = 0; i < n; i += step) {
      const d1 = cloudDistance(pts, tmpl, n, i);
      const d2 = cloudDistance(tmpl, pts, n, i);
      min = Math.min(min, d1, d2);
    }
    return min;
  }

  // ---- recognizer -----------------------------------------------------------
  class QRecognizer {
    constructor(opts = {}) {
      this.N = opts.n ?? 32; // resample count
      this.minScore = opts.minScore ?? 0.8; // intent gate: below => reject
      // Score = 1 - weightedAvgDistance / NORM. NORM ~ half the unit box is the
      // distance scale at which a cloud is "totally unlike" the template.
      this.NORM = opts.norm ?? 0.5;
      this.templates = []; // { name, points:[normalized] }
      if (opts.builtins !== false) this._loadBuiltins();
    }

    // Add a template by example. points = array of {x,y} (0..1), multi-stroke
    // shapes passed as one concatenated array.
    add(name, points) {
      if (!points || points.length < 2) return;
      this.templates.push({ name, points: normalize(points, this.N) });
    }

    // Match a stroke (or concatenated multi-stroke cloud) against the templates.
    // -> { name, score } with score 0..1 (1 = perfect). Below minScore the
    // intent gate rejects it as { name:null, score:0 } so random scribbles and
    // shapes we don't know are left alone.
    recognize(points) {
      if (!points || points.length < 2 || this.templates.length === 0) return { name: null, score: 0 };
      const cand = normalize(points, this.N);
      let best = null;
      let bestScore = -Infinity;
      const weightSum = (this.N + 1) / 2; // total pass weight -> weighted average
      for (const t of this.templates) {
        const d = greedyCloudMatch(cand, t.points, this.N);
        const score = 1 - d / weightSum / this.NORM;
        if (score > bestScore) {
          bestScore = score;
          best = t.name;
        }
      }
      bestScore = Math.max(0, Math.min(1, bestScore));
      if (best == null || bestScore < this.minScore) return { name: null, score: 0 };
      return { name: best, score: bestScore };
    }

    // Built-in starter set. Each template is authored from line/arc segments and
    // concatenated into one cloud (order doesn't matter to $P). One representative
    // example per shape is enough for a point-cloud recognizer.
    _loadBuiltins() {
      for (const [name, pts] of Object.entries(builtinClouds())) this.add(name, pts);
    }
  }

  // ---- built-in template point clouds ---------------------------------------
  // Sample a straight segment a->b into k points (endpoints included).
  function seg(a, b, k = 10) {
    return Array.from({ length: k }, (_, i) => {
      const t = i / (k - 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    });
  }
  // Sample a circular arc (angles in radians) into k points.
  function arc(cx, cy, r, a0, a1, k = 24) {
    return Array.from({ length: k }, (_, i) => {
      const a = a0 + ((a1 - a0) * i) / (k - 1);
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
  }
  const P = (x, y) => ({ x, y });

  function builtinClouds() {
    return {
      // Horizontal shaft + a small V arrowhead at the right end.
      arrow: [
        ...seg(P(0.08, 0.5), P(0.82, 0.5), 16),
        ...seg(P(0.6, 0.34), P(0.82, 0.5), 8),
        ...seg(P(0.82, 0.5), P(0.6, 0.66), 8),
      ],
      // Checkmark: short down-stroke into a long up-stroke.
      check: [
        ...seg(P(0.18, 0.52), P(0.4, 0.78), 8),
        ...seg(P(0.4, 0.78), P(0.82, 0.18), 14),
      ],
      // X: two crossing diagonals.
      x: [
        ...seg(P(0.2, 0.2), P(0.8, 0.8), 12),
        ...seg(P(0.8, 0.2), P(0.2, 0.8), 12),
      ],
      // Digit 0: a closed oval.
      "0": arc(0.5, 0.5, 0.32, -Math.PI / 2, (3 * Math.PI) / 2, 30),
      // Digit 1: little up-flag + vertical stem + base serif.
      "1": [
        ...seg(P(0.36, 0.32), P(0.5, 0.2), 6),
        ...seg(P(0.5, 0.2), P(0.5, 0.82), 16),
        ...seg(P(0.36, 0.82), P(0.66, 0.82), 8),
      ],
      // Digit 7: top bar + diagonal down to the lower-left.
      "7": [
        ...seg(P(0.24, 0.22), P(0.76, 0.22), 12),
        ...seg(P(0.76, 0.22), P(0.44, 0.82), 14),
      ],
    };
  }

  const api = { QRecognizer, resample, normalize, scaleToUnit, translateToOrigin };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DrawMeQ = api;
})(typeof window !== "undefined" ? window : null);
