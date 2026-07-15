// draw.me — pipeline (MAIN world)
// Patches getUserMedia so any site that asks for the camera receives an
// augmented canvas stream: real video + gesture-driven drawing, composited
// locally. All ML runs on-device from bundled assets.

(() => {
  "use strict";

  // Idempotent install guard (content scripts can run once per frame, but be safe).
  if (window.__drawmeInstalled) return;
  window.__drawmeInstalled = true;

  // Pure gesture + drawing logic (loaded by engine.js, tested in Node).
  const { GestureController, Strokes, SwipeDetector, FistClench, UndoHistory, handOpenness, isShake, depthTransform, fivePinch } = window.DrawMeEngine;

  // Actions that modify the board continuously (many frames per gesture). An undo
  // entry is committed only when one of these SETTLES, so it's one entry per
  // stroke/erase/drag — not one per frame.
  const MODIFYING = new Set(["draw", "erase", "grab", "grabShape", "transform"]);
  const MAX_HISTORY = 8; // cleared-board thumbnails kept in the side strip
  const BINDINGS = window.DrawMeBindings; // gesture catalog + default bindings

  // Which hand (Left/Right) is hand `i`, as the USER perceives it. MediaPipe
  // returns handedness assuming a SELFIE-MIRRORED input, but we feed it the RAW
  // frame — so its label is swapped vs the physical hand. We swap it back, then
  // (when the on-screen view is mirrored) it also matches the side you see. Comes
  // with a confidence score. -> { label:"Left"|"Right", score } or null.
  function handInfo(res, i) {
    const h = (res && (res.handedness || res.handednesses)) || [];
    const cat = h[i] && h[i][0];
    if (!cat) return null;
    const raw = cat.categoryName || cat.displayName || "";
    const label = raw === "Left" ? "Right" : raw === "Right" ? "Left" : raw;
    return { label, score: cat.score ?? 0 };
  }

  // Fingertip-cluster centre of a hand IF it's a five-finger pinch, in
  // mirror-aware display space (plus its spread); else null. Two of these = the
  // two-hand transform. Spread lets the transform freeze when a hand opens.
  function handFiveCenter(lm, mirror) {
    if (!lm || lm.length < 21) return null;
    const fp = fivePinch(lm);
    if (!fp.on) return null;
    return { x: mirror ? 1 - fp.center.x : fp.center.x, y: fp.center.y, spread: fp.spread };
  }

  // ---- shared state ---------------------------------------------------------
  const state = {
    base: null, // moz-extension://<uuid>/  (from the bridge)
    saved: null, // last persisted { strokes, history } (restored on load)
    settings: { enabled: true, active: true, mirror: true, boost: true, assist: true, debug: true, minimap: true, history: true, spotlight: true, color: "#ff2d55", size: 6, clearNonce: 0, undoNonce: 0, redoNonce: 0, bindings: { ...window.DrawMeBindings.DEFAULT_BINDINGS } },
  };
  const active = new Set(); // live Augmentor instances (for live setting updates)

  // ---- config channel (from the isolated bridge) ----------------------------
  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg && msg.__drawme === "restore") {
      state.saved = msg.drawing || null;
      for (const aug of active) aug.restoreDrawing(state.saved);
      return;
    }
    if (!msg || msg.__drawme !== "config") return;
    if (msg.base) state.base = msg.base;
    const prev = { clear: state.settings.clearNonce, undo: state.settings.undoNonce, redo: state.settings.redoNonce };
    state.settings = { ...state.settings, ...msg.settings };
    for (const aug of active) {
      aug.applySettings(state.settings);
      if (state.settings.clearNonce !== prev.clear) aug.clear();
      if (state.settings.undoNonce !== prev.undo) aug.performUndo();
      if (state.settings.redoNonce !== prev.redo) aug.performRedo();
    }
  });
  // Ask the bridge to (re)send config in case it loaded before us.
  window.postMessage({ __drawme: "ready" }, "*");

  function postStatus(status) {
    window.postMessage({ __drawme: "status", status }, "*");
  }
  function postDisarm() {
    window.postMessage({ __drawme: "disarm" }, "*");
  }

  // ---- MediaPipe Gesture Recognizer (trained model, lazy singleton) ---------
  // Returns BOTH hand landmarks and a trained gesture label (Closed_Fist,
  // Open_Palm, Pointing_Up, Victory, Thumb_Up/Down, ILoveYou, None).
  let recognizerPromise = null;
  async function getRecognizer() {
    if (recognizerPromise) return recognizerPromise;
    recognizerPromise = (async () => {
      const url = state.base + "vendor/tasks-vision/vision_bundle.mjs";
      const vision = await import(url);
      const { GestureRecognizer, FilesetResolver } = vision;
      const fileset = await FilesetResolver.forVisionTasks(state.base + "vendor/tasks-vision");
      const opts = {
        baseOptions: {
          modelAssetPath: state.base + "vendor/tasks-vision/gesture_recognizer.task",
        },
        runningMode: "VIDEO",
        numHands: 2, // second hand enables the two-fist transform
        // Low floors so the palm detector still locks onto the hand against a
        // busy, broad-patterned background (and in dim light). Tracking floor is
        // a touch higher so it stays on the real hand once found.
        minHandDetectionConfidence: 0.3,
        minHandPresenceConfidence: 0.3,
        minTrackingConfidence: 0.35,
      };
      try {
        return await GestureRecognizer.createFromOptions(fileset, {
          ...opts,
          baseOptions: { ...opts.baseOptions, delegate: "GPU" },
        });
      } catch (gpuErr) {
        console.warn("[draw.me] GPU delegate failed, using CPU", gpuErr);
        return GestureRecognizer.createFromOptions(fileset, {
          ...opts,
          baseOptions: { ...opts.baseOptions, delegate: "CPU" },
        });
      }
    })();
    return recognizerPromise;
  }

  // ---- augmentor: wraps one real stream, produces a canvas stream -----------
  class Augmentor {
    constructor(realStream, settings) {
      this.real = realStream;
      this.settings = { ...settings };
      this.ctrl = new GestureController(BINDINGS.GESTURES);
      this.strokes = new Strokes();
      this.hist = new UndoHistory({ max: 60 }); // per-action undo/redo
      this.hist.init(this.strokes.snapshot());
      this.dirty = false; // board changed since the last commit
      this.history = []; // cleared-board thumbnails { el, url, strokes } for the strip
      this.histDrag = null; // five-finger drag from the strip: { idx, at } or null
      this.historyHover = -1; // thumbnail highlighted by hovering (grab candidate)
      this.raf = null;
      this.recognizer = null;
      this.cursor = null;
      this.gestureName = null;
      this.gestureScore = 0;
      this.curMode = "idle";
      this.curRatio = null;
      this.action = null; // current action (from the bindings map)
      this.grabX = null; // one-fist grab: { snap, start } (absolute transform)
      this.xform = null; // two-hand transform: { snap, center, len, angle }
      this.transformA = null; // two-hand grab points (indicator)
      this.transformB = null;
      this.transformCenter = null; // transform pivot (indicator)
      this.txSpread = null; // last { a, b } two-hand spreads (freeze-on-release)
      this.shapeGrab = null; // move-one-shape: { i, last } (picked item + last pointer)
      this.swipe = new SwipeDetector(); // index-point + swipe = clear all
      this.fistClench = new FistClench(); // double fist-clench = compound gesture
      this.prevGesture = "none"; // resolved gesture last frame (for fire-once actions)
      this.handInfo = null; // { label:"Left"|"Right", score } of the active hand
      this.detHist = []; // recent { t, on } detection samples (rolling "seen %")
      this.hands = []; // current frame's landmark sets (for the hand-glow spotlight)
      this.clearFlash = 0; // timestamp of the last swipe-clear (for a flash)
      this.lastActivity = 0; // last time a gesture actually did something
      this.disarmSent = false; // guard so the idle-disarm message fires once
      this.wasActive = false; // armed-state edge detection
      this.IDLE_DISARM_MS = 15000; // auto-disarm after this much inactivity
      this.frames = 0;
      this.fps = 0;
      this.fpsClock = performance.now();
      this.lastStatus = 0;
      this.stopped = false;

      this.video = document.createElement("video");
      this.video.autoplay = true;
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = realStream;

      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { alpha: false });

      // Separate, downscaled + brightened canvas fed ONLY to the model, so the
      // hand separates from a dark face in low light. The output stream is
      // never brightened — this affects detection only.
      this.inf = document.createElement("canvas");
      this.infCtx = this.inf.getContext("2d", { alpha: false });
    }

    applySettings(s) {
      this.settings = { ...this.settings, ...s };
    }
    clear() {
      this.clearBoard(performance.now()); // saves a thumbnail + one undo step
    }

    async start() {
      await this.video.play().catch(() => {});
      // Wait for real frame dimensions so the canvas matches the camera's true
      // aspect ratio (getSettings() can disagree and squeeze the picture).
      if (!this.video.videoWidth) {
        await new Promise((r) => {
          this.video.addEventListener("loadedmetadata", r, { once: true });
          setTimeout(r, 1500); // don't hang if the event never fires
        });
      }
      const track = this.real.getVideoTracks()[0];
      const s = (track && track.getSettings && track.getSettings()) || {};
      this.canvas.width = this.video.videoWidth || s.width || 640;
      this.canvas.height = this.video.videoHeight || s.height || 480;

      // Kick off model load (non-blocking; frames pass through until ready).
      getRecognizer()
        .then((r) => (this.recognizer = r))
        .catch((err) => console.warn("[draw.me] recognizer load failed", err));

      const fps = (track && track.getSettings && track.getSettings().frameRate) || 30;
      this.output = this.canvas.captureStream(fps);

      // Carry audio through untouched.
      for (const a of this.real.getAudioTracks()) this.output.addTrack(a);

      // Clean up when either side stops.
      const outTrack = this.output.getVideoTracks()[0];
      const origStop = outTrack.stop.bind(outTrack);
      outTrack.stop = () => {
        this.stop();
        origStop();
      };
      if (track) track.addEventListener("ended", () => this.stop());

      this.loop();
      return this.output;
    }

    eraseRadiusPx() {
      // Small, precise eraser at the thumb tip (not a fist-sized blob).
      return this.settings.size * 2 + 14;
    }

    // Hand reference for a depth transform: apparent size (wrist↔knuckle = depth
    // proxy), wrist-roll angle (rotate, mirror-aware), and a pan position.
    handRef(lms, pos) {
      const w = lms[0];
      const mmcp = lms[9];
      const size = Math.hypot(mmcp.x - w.x, mmcp.y - w.y) || 1e-3;
      const adx = this.settings.mirror ? -(mmcp.x - w.x) : mmcp.x - w.x;
      return { size, angle: Math.atan2(mmcp.y - w.y, adx), pos };
    }

    // Route a gesture's ACTION (from the bindings map) to its handler. Manages
    // transitions (finalize strokes, release transform snapshots) so each action
    // handler stays small and independent — this is the separation-of-concerns seam.
    dispatch(action, g, gesture, twoHand, lms, aspect, ts) {
      if (action !== "draw" && this.strokes.current) this.strokes.end(this.settings.assist, aspect, ts);
      if (action !== "grab") this.grabX = null;
      if (action !== "grabShape") this.shapeGrab = null;
      if (action !== "historyDrag") this.finishHistoryDrag(!!lms); // pass hand presence
      if (action !== "transform") {
        this.xform = null;
        this.transformA = null;
        this.transformB = null;
        this.txSpread = null;
      }
      if (action !== "erase") this.swipe.reset();

      if (action === "draw") this.actDraw(g);
      else if (action === "erase") this.actErase(g, ts);
      else if (action === "grab") this.actGrab(g, lms, aspect);
      else if (action === "grabShape") this.actGrabShape(g);
      else if (action === "historyDrag") this.actHistoryDrag(g);
      else if (action === "transform") this.actTransform(twoHand, aspect);
      else if (action === "clear") this.actClear(g, ts);
      else this.cursor = g.point ? { x: g.point.x, y: g.point.y, mode: "idle", active: false } : null;

      this.action = action;
      this.curMode = action || "idle";
      this.gestureName = gesture === "none" ? "—" : gesture;
      this.curRatio = g.ratio;
      if (action) this.lastActivity = ts;
    }

    // --- action handlers (one per action name in the bindings map) ---
    actDraw(g) {
      if (!g.point) return;
      if (g.settled) {
        if (this.strokes.current) this.strokes.extend(g.point);
        else this.strokes.begin(g.point, this.settings.color, this.settings.size);
        this.dirty = true;
      }
      this.cursor = { x: g.point.x, y: g.point.y, mode: "pen", active: g.settled };
    }

    actErase(g, ts) {
      if (!g.point) return;
      const r = this.eraseRadiusPx();
      if (this.strokes.eraseAt(g.point, r / this.canvas.width)) this.dirty = true;
      if (this.swipe.update(true, g.point, ts)) this.clearBoard(ts); // index-swipe = clear
      this.cursor = { x: g.point.x, y: g.point.y, mode: "erase", radius: r, active: true };
    }

    // Clear all: fire ONCE when the (resolved) gesture is entered — holding it,
    // or a compound like the double fist-clench, shouldn't re-clear every frame.
    actClear(g, ts) {
      if (this.gestureChanged) this.clearBoard(ts);
      this.cursor = g.point ? { x: g.point.x, y: g.point.y, mode: "idle", active: false } : null;
    }

    // Drag-restore from the history strip with the five-finger pinch: pinch ON a
    // thumbnail to pick it up, drag it out onto the board, release to restore that
    // board (editable). Release back over the strip cancels. The floating preview
    // is drawn in drawHistoryDrag. this.histDrag = { idx, at } (at = live point).
    actHistoryDrag(g) {
      if (!g.point) return;
      if (!this.histDrag) {
        // Grab the thumbnail you HIGHLIGHTED by hovering (set in drawHistory) —
        // the pinch does NOT auto-select whatever it happens to be over. Nothing
        // highlighted → grabs nothing.
        this.histDrag = { idx: this.historyHover, at: { x: g.point.x, y: g.point.y }, path: [], cancelled: false };
      }
      const d = this.histDrag;
      d.at = { x: g.point.x, y: g.point.y };
      // Shake-to-cancel: many fast reversals over the last ~450ms drops the pick
      // for good (this gesture) — no restore on release, no re-grab.
      if (d.idx >= 0) {
        d.path.push({ x: g.point.x, y: g.point.y, t: performance.now() });
        while (d.path.length && d.path[d.path.length - 1].t - d.path[0].t > 450) d.path.shift();
        if (isShake(d.path)) {
          d.idx = -1;
          d.cancelled = true;
        }
      }
      const holding = d.idx >= 0;
      this.cursor = { x: g.point.x, y: g.point.y, mode: holding ? "move" : "idle", active: holding };
    }

    // End a history drag. Restore ONLY on an intentional release: the hand still
    // present, a thumbnail still picked (not shaken off), dropped OFF the strip.
    // Hand gone (moved out of frame) or shaken → discard silently.
    finishHistoryDrag(present) {
      const d = this.histDrag;
      if (!d) return;
      this.histDrag = null;
      // restore only if dragged OFF the right-side zone onto the board
      if (present && d.idx >= 0 && this.historyHoverAt(d.at) < 0) {
        if (this.restoreFromHistory(d.idx)) this.clearFlash = performance.now();
      }
    }

    // Save the current drawing as a history thumbnail, then wipe the board — and
    // record it as one undo step. Used by every "clear" path (gesture, swipe,
    // popup button). No-op on an already-empty board.
    clearBoard(ts) {
      if (!this.strokes.list.length) return;
      this.saveThumbnail();
      this.strokes.clear();
      this.clearFlash = ts || performance.now();
      this.hist.commit(this.strokes.snapshot());
      this.dirty = false;
      this.persist();
    }

    // Commit one undo step once a continuous action has SETTLED (the board
    // changed and we're no longer mid-stroke/erase/drag).
    maybeCommit() {
      if (this.dirty && !MODIFYING.has(this.action)) {
        this.hist.commit(this.strokes.snapshot());
        this.dirty = false;
        this.persist();
      }
    }

    performUndo() {
      // flush an in-flight change first so undo lands on a clean boundary
      this.maybeCommit();
      const s = this.hist.undoTo();
      if (s) {
        this.strokes.restore(s);
        this.persist();
      }
    }
    performRedo() {
      const s = this.hist.redoTo();
      if (s) {
        this.strokes.restore(s);
        this.persist();
      }
    }

    // Snapshot the current drawing into a small thumbnail canvas for the side
    // history strip (rendered from the strokes, so it's crisp at any size).
    saveThumbnail() {
      const W = 160;
      const H = Math.round((W * this.canvas.height) / this.canvas.width) || 120;
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const cx = c.getContext("2d");
      cx.fillStyle = "rgba(20,21,26,0.92)";
      cx.fillRect(0, 0, W, H);
      this.strokes.render(cx, W, H, -1);
      // el = drawable (canvas now, Image when restored); url = PNG for persistence;
      // strokes = the vector snapshot so the board can be RESTORED editable.
      this.history.unshift({ el: c, url: c.toDataURL("image/png"), strokes: this.strokes.snapshot() });
      if (this.history.length > MAX_HISTORY) this.history.pop();
    }

    // Persist the current board + history to storage (via the isolated bridge).
    // Called on discrete changes (commit / clear / undo / redo), never per frame.
    persist() {
      try {
        window.postMessage(
          { __drawme: "persist", drawing: { strokes: this.strokes.snapshot(), history: this.history.map((h) => ({ url: h.url, strokes: h.strokes })) } },
          window.location.origin === "null" ? "*" : window.location.origin,
        );
      } catch (_) {
        /* postMessage can throw on some origins; persistence is best-effort */
      }
    }

    // Restore a saved board + history (from the bridge on page load).
    restoreDrawing(data) {
      if (!data) return;
      if (Array.isArray(data.strokes)) {
        this.strokes.restore(data.strokes);
        this.hist.init(this.strokes.snapshot());
        this.dirty = false;
      }
      if (Array.isArray(data.history)) {
        this.history = data.history.map((h) => {
          const url = typeof h === "string" ? h : h.url; // tolerate the old url-only format
          const img = new Image();
          img.src = url;
          return { el: img, url, strokes: h && h.strokes ? h.strokes : null };
        });
      }
    }

    // Load a saved board from the history strip back onto the canvas (editable).
    // Current board goes to the undo stack first, so it's not lost.
    restoreFromHistory(idx) {
      const item = this.history[idx];
      if (!item || !Array.isArray(item.strokes)) return false;
      this.maybeCommit();
      this.strokes.restore(item.strokes);
      this.hist.commit(this.strokes.snapshot());
      this.dirty = false;
      this.persist();
      return true;
    }

    // One fist: pan (move) + zoom (depth) + rotate (wrist) the whole canvas,
    // absolute from a snapshot pivoting on the screen centre (no drift).
    actGrab(g, lms, aspect) {
      if (!g.point || !lms) return;
      const cur = this.handRef(lms, g.point);
      if (!this.grabX) {
        this.grabX = { snap: this.strokes.snapshot(), start: { ...cur, center: { x: 0.5, y: 0.5 } } };
      } else if (g.settled) {
        // Only commit while the hold is stable. When the fingers start opening
        // (release), g.settled goes false and we FREEZE — the canvas keeps the
        // last committed scale/rotation instead of tracking the release motion.
        const d = depthTransform(this.grabX.start, cur, { rotGain: 1.5 });
        this.strokes.restore(this.grabX.snap);
        this.strokes.transformAll(d.scale, d.rotate, this.grabX.start.center, aspect);
        this.strokes.translateAll(d.pan.x, d.pan.y);
        this.dirty = true;
      }
      this.transformCenter = { x: 0.5, y: 0.5 };
      this.cursor = { x: g.point.x, y: g.point.y, mode: "transform", active: true };
    }

    // Move ONE shape: on gesture-enter, hit-test the pointer to pick the topmost
    // shape near it; then drag just that shape by the pointer delta. Picking once
    // (not every frame) means the drag stays with the shape you grabbed even if
    // the pointer wanders over others — and grabbing empty space does nothing.
    actGrabShape(g) {
      if (!g.point) return;
      if (!this.shapeGrab) {
        const i = this.strokes.hitTest(g.point, 0.05);
        this.shapeGrab = { i, last: { x: g.point.x, y: g.point.y } };
      } else if (this.shapeGrab.i >= 0) {
        this.strokes.translate(this.shapeGrab.i, g.point.x - this.shapeGrab.last.x, g.point.y - this.shapeGrab.last.y);
        this.shapeGrab.last = { x: g.point.x, y: g.point.y };
        this.dirty = true;
      }
      const holding = this.shapeGrab.i >= 0;
      this.cursor = { x: g.point.x, y: g.point.y, mode: holding ? "move" : "idle", active: holding };
    }

    // Two five-finger pinches: distance = scale, angle = rotate, midpoint = pan —
    // the classic two-point transform, absolute from a fixed-pivot snapshot.
    // Commits only while BOTH hands hold steadily (tf.settled); freezes on release.
    actTransform(tf, aspect) {
      const { pa, pb } = tf;
      const center = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1e-6;
      const angle = Math.atan2(pb.y - pa.y, pb.x - pa.x);
      if (!this.xform) {
        this.xform = { snap: this.strokes.snapshot(), center, len, angle };
      } else if (tf.settled !== false) {
        const x0 = this.xform;
        this.strokes.restore(x0.snap);
        this.strokes.transformAll(len / x0.len, angle - x0.angle, x0.center, aspect);
        this.strokes.translateAll(center.x - x0.center.x, center.y - x0.center.y);
        this.dirty = true;
      }
      this.transformA = pa;
      this.transformB = pb;
      this.transformCenter = this.xform.center;
      this.cursor = { x: center.x, y: center.y, mode: "transform", active: true };
    }

    // Transform indicators: the pivot (white ring), and — for a two-fist
    // transform — the two grab points (cyan) and the axis between them, so you
    // can see WHAT you're grabbing and around WHICH centre.
    drawHandles(ctx, canvas) {
      if (this.curMode !== "transform" || !this.transformCenter) return;
      const W = canvas.width;
      const H = canvas.height;
      if (this.transformA && this.transformB) {
        ctx.beginPath();
        ctx.moveTo(this.transformA.x * W, this.transformA.y * H);
        ctx.lineTo(this.transformB.x * W, this.transformB.y * H);
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(80,200,255,0.9)";
        ctx.stroke();
        ctx.setLineDash([]);
        for (const p of [this.transformA, this.transformB]) {
          ctx.beginPath();
          ctx.arc(p.x * W, p.y * H, 9, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(80,200,255,0.95)";
          ctx.fill();
        }
      }
      const c = this.transformCenter;
      ctx.beginPath();
      ctx.arc(c.x * W, c.y * H, 15, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c.x * W, c.y * H, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fill();
    }

    // Figma-style minimap (bottom-left): a scaled overview of EVERY stroke at its
    // true position, plus a white rectangle marking the visible camera frame — so
    // you can find drawings you've panned/zoomed off-screen. Stroke coords are
    // ALREADY in mirrored display space (the gesture anchor flips x when mirror is
    // on, and the main render draws them un-flipped over the flipped video), so
    // the minimap draws them directly — no extra flip, or it would double-mirror.
    drawMinimap(ctx, canvas) {
      const b = this.strokes.bounds();
      if (!b) return; // nothing drawn yet
      const W = canvas.width;
      const H = canvas.height;
      // World = union of the strokes' bounds and the visible frame [0,1]², so the
      // frame box is always shown even when all ink sits inside it.
      const wx0 = Math.min(0, b.minx);
      const wy0 = Math.min(0, b.miny);
      const wx1 = Math.max(1, b.maxx);
      const wy1 = Math.max(1, b.maxy);
      // Fit the world into the panel preserving PIXEL aspect (normalized coords
      // are per-axis, so a world unit is W px wide but H px tall).
      const worldPxW = (wx1 - wx0) * W || 1;
      const worldPxH = (wy1 - wy0) * H || 1;
      const maxW = Math.min(150, W * 0.24);
      const maxH = Math.min(110, H * 0.34);
      const s = Math.min(maxW / worldPxW, maxH / worldPxH);
      const contentW = worldPxW * s;
      const contentH = worldPxH * s;
      const pad = 14;
      const ox = pad; // bottom-left corner
      const oy = H - pad - contentH;
      // world normalized point (display space) -> minimap screen px
      const mx = (nx) => ox + (nx - wx0) * W * s;
      const my = (ny) => oy + (ny - wy0) * H * s;

      ctx.save();
      // panel backdrop
      ctx.fillStyle = "rgba(20,21,26,0.68)";
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(ox - 6, oy - 6, contentW + 12, contentH + 12);
      ctx.fill();
      ctx.stroke();

      // every item as a thin polyline in its own colour (fixed width, so it stays
      // visible no matter how far the world is zoomed out)
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.lineWidth = 1.25;
      for (const it of this.strokes.list) {
        ctx.strokeStyle = it.color || "#ff2d55";
        ctx.beginPath();
        if (it.kind === "line") {
          ctx.moveTo(mx(it.a.x), my(it.a.y));
          ctx.lineTo(mx(it.b.x), my(it.b.y));
        } else if (it.kind === "ellipse") {
          for (let k = 0; k <= 24; k++) {
            const t = (k / 24) * Math.PI * 2;
            const px = mx(it.cx + it.rx * Math.cos(t));
            const py = my(it.cy + it.ry * Math.sin(t));
            k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
        } else {
          const arr = it.kind === "poly" ? it.pts : it.points;
          arr.forEach((p, k) => (k === 0 ? ctx.moveTo(mx(p.x), my(p.y)) : ctx.lineTo(mx(p.x), my(p.y))));
          if (it.kind === "poly" && it.closed) ctx.closePath();
        }
        ctx.stroke();
      }

      // the visible camera frame [0,1]² as a bright rectangle
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(mx(0), my(0), W * s, H * s);

      // the live cursor as a small dot, so you can locate your hand on the map
      if (this.cursor) {
        ctx.beginPath();
        ctx.arc(mx(this.cursor.x), my(this.cursor.y), 3, 0, Math.PI * 2);
        ctx.fillStyle = this.cursor.active ? this.settings.color : "rgba(255,255,255,0.9)";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.stroke();
      }
      ctx.restore();
    }

    // History strip (right edge): stacked thumbnails of past drawings, newest on
    // top. Each is auto-saved when the board is cleared. Drawn unmirrored (screen
    // space) so the little previews read the right way round.
    // Pixel rects of the visible history thumbnails (shared by draw + hit-test).
    historyRects(canvas) {
      const W = canvas.width;
      const H = canvas.height;
      const w = Math.min(84, W * 0.11);
      const h = Math.round((w * H) / W);
      const x = W - w - 10;
      const rects = [];
      let y = 48; // below the top-right armed badge
      for (let i = 0; i < this.history.length; i++) {
        if (y + h > H - 12) break;
        rects.push({ i, x, y, w, h });
        y += h + 6;
      }
      return rects;
    }
    // Index of the history thumbnail under a normalized point, or -1. `pad`
    // enlarges the hit target (the five-finger cluster centre is imprecise).
    historyAt(pt, pad = 0) {
      if (!pt) return -1;
      const px = pt.x * this.canvas.width;
      const py = pt.y * this.canvas.height;
      for (const r of this.historyRects(this.canvas)) {
        if (px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad) return r.i;
      }
      return -1;
    }
    // Forgiving HOVER hit-test: select by HEIGHT while your hand is anywhere in
    // the right ~third of the frame — so you never have to reach the edge (where
    // the hand leaves frame and detection drops). Returns the thumbnail whose row
    // your hand is level with, or -1.
    historyHoverAt(pt) {
      if (!pt) return -1;
      const rects = this.historyRects(this.canvas);
      if (!rects.length) return -1;
      const W = this.canvas.width;
      const px = pt.x * W;
      const py = pt.y * this.canvas.height;
      if (px < rects[0].x - W * 0.28) return -1; // must be on the right side (no edge needed)
      for (const r of rects) {
        if (py >= r.y - 4 && py <= r.y + r.h + 4) return r.i; // matched by row height
      }
      return -1;
    }
    drawHistory(ctx, canvas) {
      const rects = this.historyRects(canvas);
      if (!rects.length) {
        this.historyHover = -1;
        return;
      }
      // While NOT dragging, the thumbnail your hand is level with (right side of
      // frame, by row) is the grab candidate — no need to reach the edge. Once
      // dragging, the picked one stays highlighted.
      if (!this.histDrag) this.historyHover = this.cursor ? this.historyHoverAt(this.cursor) : -1;
      const dragIdx = this.histDrag && this.histDrag.idx >= 0 ? this.histDrag.idx : -1;
      const hi = dragIdx >= 0 ? dragIdx : this.historyHover;
      ctx.save();
      for (const r of rects) {
        const item = this.history[r.i];
        ctx.fillStyle = "rgba(20,21,26,0.6)";
        ctx.fillRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
        if (item.el && (item.el.width || item.el.complete)) ctx.drawImage(item.el, r.x, r.y, r.w, r.h);
        const on = r.i === hi;
        ctx.strokeStyle = on ? "#ffd23f" : "rgba(255,255,255,0.35)";
        ctx.lineWidth = on ? 3 : 1;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
      ctx.restore();
    }

    // Floating preview of the thumbnail being dragged out of the strip (drawn on
    // top of everything, following the hand), so the drag is visible.
    drawHistoryDrag(ctx, canvas) {
      const d = this.histDrag;
      if (!d || d.idx < 0) return;
      const item = this.history[d.idx];
      if (!item || !item.el || !(item.el.width || item.el.complete)) return;
      const W = canvas.width;
      const H = canvas.height;
      const w = Math.min(110, W * 0.15);
      const h = Math.round((w * H) / W);
      const x = d.at.x * W - w / 2;
      const y = d.at.y * H - h / 2;
      const onStrip = this.historyHoverAt(d.at) >= 0; // still on the right side = not yet dropped
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "rgba(20,21,26,0.9)";
      ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
      ctx.drawImage(item.el, x, y, w, h);
      ctx.strokeStyle = onStrip ? "rgba(255,255,255,0.5)" : "#35c759"; // green = will restore
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    // Green border + "DRAWING" badge while armed (top-right, unmirrored).
    drawArmed(ctx, canvas) {
      const lw = Math.max(3, Math.round(canvas.width * 0.006));
      ctx.strokeStyle = "rgba(53,199,89,0.9)";
      ctx.lineWidth = lw;
      ctx.strokeRect(lw / 2, lw / 2, canvas.width - lw, canvas.height - lw);
      const s = Math.max(13, Math.round(canvas.width * 0.022));
      ctx.font = `600 ${s}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      const label = "● DRAWING";
      const pad = Math.round(s * 0.5);
      const w = ctx.measureText(label).width + pad * 2;
      const x = canvas.width - w - lw - pad;
      const y = lw + pad;
      ctx.fillStyle = "rgba(53,199,89,0.92)";
      ctx.fillRect(x, y, w, s + pad);
      ctx.fillStyle = "#0a0c12";
      ctx.fillText(label, x + pad, y + pad / 2);
    }

    // Live gesture debug overlay (drawn unmirrored, so text is readable).
    drawHud(ctx, canvas, hand) {
      if (!this.settings.active) {
        this.hudLines(ctx, canvas, [["STATUS", "disarmed · Alt+Shift+D to draw", "#8b90a3"]]);
        return;
      }
      if (!this.recognizer) {
        this.hudLines(ctx, canvas, [["DETECT", "loading model…", "#ffcc00"]]);
        return;
      }
      // DETECT = does the model see a HAND at all (separate from any gesture).
      // "seen X%" is the fraction of the last ~1.5s where a hand was found, so a
      // low number = the detector is dropping your hand, not a gesture problem.
      const seen = this.detHist.length ? Math.round((100 * this.detHist.filter((d) => d.on).length) / this.detHist.length) : 0;
      const detect = hand
        ? ["DETECT", `${this.handInfo ? this.handInfo.label + " hand" : "hand"} · seen ${seen}%`, "#35c759"]
        : ["DETECT", `searching… no hand · seen ${seen}%`, "#ffcc00"];
      const action = (this.curMode || "idle").toUpperCase();
      const pinch = this.curRatio != null ? this.curRatio.toFixed(2) : "-";
      this.hudLines(ctx, canvas, [
        detect,
        ["GESTURE", hand ? this.gestureName || "—" : "—", "#ffffff"],
        ["ACTION", action, this.modeColor(this.curMode)],
        ["pinch", `${pinch}  (draw < 0.40)`, "#c9cdda"],
      ]);
    }
    hudLines(ctx, canvas, lines) {
      const s = Math.max(10, Math.round(canvas.width * 0.016));
      ctx.font = `${s}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = "top";
      const pad = Math.round(s * 0.6);
      const lh = Math.round(s * 1.45);
      const labelW = Math.round(s * 4.2);
      let boxW = 0;
      for (const [, v] of lines) boxW = Math.max(boxW, labelW + ctx.measureText(v).width);
      boxW += pad * 2;
      ctx.fillStyle = "rgba(10,12,18,0.62)";
      ctx.fillRect(pad, pad, boxW, lh * lines.length + pad * 2);
      lines.forEach(([label, value, color], i) => {
        const y = pad + pad + i * lh;
        ctx.fillStyle = "#8b90a3";
        ctx.fillText(label, pad + pad, y);
        ctx.fillStyle = color;
        ctx.fillText(value, pad + pad + labelW, y);
      });
    }
    modeColor(m) {
      return m === "pen" ? "#35c759" : m === "erase" ? "#ff453a" : m === "move" ? "#50c8ff" : m === "transform" ? "#c77dff" : "#8b90a3";
    }

    // Dotted circle around every detected FINGERTIP (thumb amber, fingers cyan) —
    // a precise "here's exactly what the model is tracking" overlay. Radius scales
    // with the hand's pixel size so it stays proportional near or far.
    drawFingertips(ctx, canvas) {
      const W = canvas.width;
      const H = canvas.height;
      const mir = this.settings.mirror;
      const TIPS = [4, 8, 12, 16, 20]; // thumb, index, middle, ring, pinky tips
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 2;
      for (const lm of this.hands) {
        if (!lm || lm.length < 21) continue;
        const wx = (mir ? 1 - lm[0].x : lm[0].x) * W;
        const wy = lm[0].y * H;
        const mx = (mir ? 1 - lm[9].x : lm[9].x) * W;
        const my = lm[9].y * H;
        const r = Math.max(5, (Math.hypot(mx - wx, my - wy) || 40) * 0.18);
        for (const i of TIPS) {
          const px = (mir ? 1 - lm[i].x : lm[i].x) * W;
          const py = lm[i].y * H;
          ctx.strokeStyle = i === 4 ? "rgba(255,205,80,0.95)" : "rgba(110,220,255,0.95)";
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = ctx.strokeStyle; // tiny centre dot for the exact point
          ctx.beginPath();
          ctx.arc(px, py, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Spotlight: a light dim over the whole feed (so drawing colors stand out),
    // plus an additive glow on each DETECTED hand — a live indicator that the
    // model sees your hand, right where your hand is. Drawn under the ink.
    drawSpotlight(ctx, canvas) {
      const W = canvas.width;
      const H = canvas.height;
      const mir = this.settings.mirror;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.26)"; // subtle dim
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter"; // additive → the glow adds light
      for (const lm of this.hands) {
        if (!lm || lm.length < 21) continue;
        // palm centre = wrist + the four MCP knuckles (stable, not a fingertip)
        let cx = 0;
        let cy = 0;
        for (const i of [0, 5, 9, 13, 17]) {
          cx += lm[i].x;
          cy += lm[i].y;
        }
        cx /= 5;
        cy /= 5;
        const px = (mir ? 1 - cx : cx) * W;
        const py = cy * H;
        // radius from the palm size in PIXELS (wrist → middle knuckle)
        const wx = (mir ? 1 - lm[0].x : lm[0].x) * W;
        const wy = lm[0].y * H;
        const mx = (mir ? 1 - lm[9].x : lm[9].x) * W;
        const my = lm[9].y * H;
        const r = Math.max(40, Math.hypot(mx - wx, my - wy) * 1.8);
        const g = ctx.createRadialGradient(px, py, 0, px, py, r);
        g.addColorStop(0, "rgba(150,220,255,0.45)");
        g.addColorStop(0.5, "rgba(90,180,255,0.14)");
        g.addColorStop(1, "rgba(90,180,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // The image handed to the model. With low-light boost on, it's a
    // downscaled, brightened/contrast-stretched copy of the frame (helps the
    // hand separate from a dark face); otherwise the raw video element.
    inferenceSource() {
      if (!this.settings.boost) return this.video;
      const vw = this.video.videoWidth || this.canvas.width;
      const vh = this.video.videoHeight || this.canvas.height;
      if (!vw) return this.video;
      const scale = Math.min(1, 560 / vw); // cap width ~560 (detail vs speed; helps busy bg)
      const iw = Math.max(1, Math.round(vw * scale));
      const ih = Math.max(1, Math.round(vh * scale));
      if (this.inf.width !== iw || this.inf.height !== ih) {
        this.inf.width = iw;
        this.inf.height = ih;
      }
      this.infCtx.filter = "brightness(1.5) contrast(1.3)";
      this.infCtx.drawImage(this.video, 0, 0, iw, ih);
      this.infCtx.filter = "none";
      return this.inf;
    }

    loop = () => {
      if (this.stopped) return;
      this.raf = requestAnimationFrame(this.loop);
      const { ctx, canvas } = this;
      const W = canvas.width;
      const H = canvas.height;
      if (this.video.readyState < 2) return;

      // Resize if source resolution changed (check both dims to keep aspect).
      if (
        this.video.videoWidth &&
        (this.video.videoWidth !== W || this.video.videoHeight !== H)
      ) {
        canvas.width = this.video.videoWidth;
        canvas.height = this.video.videoHeight;
      }

      // Layer 0: camera (mirrored for a natural selfie view).
      ctx.save();
      if (this.settings.mirror) {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
      ctx.restore();

      // Reset the idle timer the moment drawing is armed.
      const nowMs = performance.now();
      if (this.settings.active && !this.wasActive) {
        this.lastActivity = nowMs;
        this.disarmSent = false;
      }
      this.wasActive = this.settings.active;

      // Gesture inference — ONLY when drawing is armed. Disarmed = clean feed
      // with frozen drawings and zero gesture interpretation (no false positives).
      let hand = false;
      if (this.settings.active && this.recognizer) {
        const ts = performance.now();
        let res = null;
        try {
          res = this.recognizer.recognizeForVideo(this.inferenceSource(), ts);
        } catch (_) {
          /* transient; skip frame */
        }
        const allHands = (res && res.landmarks) || [];
        const lms = allHands[0];
        hand = !!lms;
        this.hands = allHands; // for the hand-glow spotlight
        this.handInfo = hand ? handInfo(res, 0) : null; // Left/Right of the active hand
        this.detHist.push({ t: ts, on: hand }); // rolling detection rate (last ~1.5s)
        while (this.detHist.length && ts - this.detHist[0].t > 1500) this.detHist.shift();
        const aspect = canvas.width / canvas.height;

        // Detect the raw gesture. A two-hand gesture overrides the single-hand
        // one. Then the USER's bindings (settings.bindings) decide the action.
        const g = this.ctrl.update(lms, null, this.settings.mirror, ts);
        let gesture = g.gesture; // pinch | point | fivePinch | none
        let twoHand = null;
        if (allHands.length >= 2) {
          const pa = handFiveCenter(allHands[0], this.settings.mirror);
          const pb = handFiveCenter(allHands[1], this.settings.mirror);
          if (pa && pb) {
            gesture = "twoFivePinch";
            // Freeze the moment EITHER hand starts opening (release), so letting
            // go can't disturb the scale/rotate/pan — same rule as the one-hand
            // grab. Spread is size-normalized, so moving the hands in depth or
            // apart (a real zoom) does NOT trip it; only opening fingers does.
            const prev = this.txSpread;
            const rising = prev ? Math.max(pa.spread - prev.a, pb.spread - prev.b) : 0;
            this.txSpread = { a: pa.spread, b: pb.spread };
            twoHand = { pa, pb, settled: rising < 0.03 };
          } else {
            this.txSpread = null;
          }
        }
        // Compound temporal gesture: a SINGLE-hand double fist-clench wins for the
        // one frame it completes. Only run it when exactly ONE hand is visible —
        // making fists with BOTH hands must never trigger it (and two hands make
        // allHands[0] flip between them, which would fake clench events).
        if (allHands.length === 1) {
          if (this.fistClench.update(true, handOpenness(lms), ts)) gesture = "doubleFist";
        } else {
          this.fistClench.reset();
        }

        // Resolved-gesture change edge (fire-once actions like clear read this,
        // since g.changed only reflects the single-hand controller, not overrides).
        this.gestureChanged = gesture !== this.prevGesture;
        this.prevGesture = gesture;

        const bindings = { ...BINDINGS.DEFAULT_BINDINGS, ...(this.settings.bindings || {}) };
        const action = bindings[gesture] || null;
        this.dispatch(action, g, gesture, twoHand, lms, aspect, ts);
        this.maybeCommit(); // one undo step per settled action
      } else {
        // Disarmed: finalize any pending stroke; ignore the hand entirely.
        if (this.strokes.current) this.strokes.end(this.settings.assist, canvas.width / canvas.height, nowMs);
        this.action = null;
        this.maybeCommit(); // flush any uncommitted change into the undo history
        this.cursor = null;
        this.gestureName = null;
        this.curMode = "idle";
        this.action = null;
        this.grabX = null;
        this.xform = null;
        this.transformA = null;
        this.transformB = null;
        this.txSpread = null;
        this.shapeGrab = null;
        this.fistClench.reset();
        this.prevGesture = "none";
        this.hands = [];
        this.histDrag = null; // disarm mid-drag = discard
      }

      // (No idle auto-disarm — drawing stays armed until you toggle it off with
      // the popup switch or Alt+Shift+D.)

      // Layer 0.5: spotlight — dim the feed so ink pops + glow each detected hand
      // (a live "I see your hand" indicator). Armed only, under the drawing.
      if (this.settings.active && this.settings.spotlight) this.drawSpotlight(ctx, canvas);

      // Layer 1: strokes + shapes (highlight the grabbed item).
      this.strokes.render(ctx, canvas.width, canvas.height, -1);

      // Cursor puck: a filled dot for the pen, a dashed circle for the eraser.
      const c = this.cursor;
      if (c) {
        const cx = c.x * canvas.width;
        const cy = c.y * canvas.height;
        if (c.mode === "erase") {
          ctx.beginPath();
          ctx.arc(cx, cy, c.radius, 0, Math.PI * 2);
          ctx.setLineDash([7, 5]);
          ctx.lineWidth = c.active ? 4 : 2;
          ctx.strokeStyle = c.active ? "rgba(255,70,70,0.95)" : "rgba(255,255,255,0.8)";
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (c.mode === "move") {
          ctx.beginPath();
          ctx.arc(cx, cy, 11, 0, Math.PI * 2);
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(80,200,255,0.95)";
          ctx.stroke();
        } else if (c.mode === "transform") {
          // Pivot marker for the two-hand scale/rotate.
          ctx.beginPath();
          ctx.arc(cx, cy, 13, 0, Math.PI * 2);
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(199,125,255,0.95)";
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, c.active ? this.settings.size + 3 : 8, 0, Math.PI * 2);
          ctx.fillStyle = c.active ? this.settings.color : "rgba(255,255,255,0.6)";
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = "rgba(0,0,0,0.5)";
          ctx.stroke();
        }
      }

      // Transform handles (grab points + pivot) for two-hand / Victory transforms.
      this.drawHandles(ctx, canvas);

      // Figma-style minimap: overview of the whole drawing + the visible frame.
      if (this.settings.active && this.settings.minimap) this.drawMinimap(ctx, canvas);

      // History strip: thumbnails of past drawings (auto-saved on each clear).
      if (this.settings.active && this.settings.history) {
        this.drawHistory(ctx, canvas);
        this.drawHistoryDrag(ctx, canvas); // floating preview while dragging one out
      }

      // Armed indicator (always shown): a green border + badge while drawing is
      // live, so you and viewers can tell it's on. Nothing when disarmed.
      if (this.settings.active) this.drawArmed(ctx, canvas);

      // Brief "cleared" flash after a fist-swipe wipe (fades over ~700ms).
      const sinceClear = performance.now() - this.clearFlash;
      if (this.clearFlash && sinceClear < 700) {
        ctx.save();
        ctx.globalAlpha = 0.5 * (1 - sinceClear / 700);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }

      // Debug HUD: what the model sees + the resolved action (top-left).
      if (this.settings.debug) {
        this.drawFingertips(ctx, canvas);
        this.drawHud(ctx, canvas, hand);
      }

      // FPS + status (throttled).
      this.frames++;
      const now = performance.now();
      if (now - this.fpsClock >= 1000) {
        this.fps = this.frames;
        this.frames = 0;
        this.fpsClock = now;
      }
      if (now - this.lastStatus > 500) {
        this.lastStatus = now;
        postStatus({
          running: true,
          armed: !!this.settings.active,
          modelReady: !!this.recognizer,
          hand,
          gesture: this.gestureName,
          drawing: !!(this.cursor && this.cursor.mode === "pen"),
          erasing: !!(this.cursor && this.cursor.mode === "erase"),
          transforming: !!(this.cursor && this.cursor.mode === "transform"),
          fps: this.fps,
          strokes: this.strokes.list.length,
        });
      }
    };

    stop() {
      if (this.stopped) return;
      this.stopped = true;
      if (this.raf) cancelAnimationFrame(this.raf);
      active.delete(this);
      for (const t of this.real.getTracks()) t.stop();
      this.video.srcObject = null;
      postStatus({ running: false });
    }
  }

  // ---- getUserMedia patch ---------------------------------------------------
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const realGUM = md.getUserMedia.bind(md);

  md.getUserMedia = async function (constraints) {
    const stream = await realGUM(constraints);
    try {
      if (!state.settings.enabled) return stream;
      if (!constraints || !constraints.video) return stream; // audio-only untouched
      const aug = new Augmentor(stream, state.settings);
      active.add(aug);
      if (state.saved) aug.restoreDrawing(state.saved); // apply a save that already arrived
      return await aug.start();
    } catch (err) {
      console.warn("[draw.me] augmentation failed; passing real camera through", err);
      return stream;
    }
  };

  console.info("[draw.me] pipeline installed (getUserMedia patched)");
})();
