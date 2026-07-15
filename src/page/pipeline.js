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
  const { GestureController, Strokes, SwipeDetector, FistClench, DoubleTap, UndoHistory, handOpenness, fingerExtended, isShake, depthTransform, fivePinch } = window.DrawMeEngine;
  const HISTORY_MODE_MS = 6000; // history mode auto-closes after this much inactivity

  // Actions that modify the board continuously (many frames per gesture). An undo
  // entry is committed only when one of these SETTLES, so it's one entry per
  // stroke/erase/drag — not one per frame.
  const MODIFYING = new Set(["draw", "erase", "grab", "grabShape", "transform"]);
  const MAX_HISTORY = 8; // cleared-board thumbnails kept in the side strip

  // Per-user pinch calibration: record YOUR pinched vs open thumb-index ratio and
  // set the draw thresholds to fit your hand + camera (instead of a global guess).
  // Each step VALIDATES the pose (orthogonally to the value we're measuring), so
  // it only records while you're genuinely making it — doing nothing can't "fill"
  // the bar with junk. `valid(lm, ratio)` → is the pose being made right now.
  const CALIB_STEPS = [
    {
      key: "pinch",
      prompt: "Pinch thumb + index together — and hold",
      hint: "touch your thumb and index tips together",
      reduce: "min",
      valid: (lm, r) => r != null && r < 0.55, // fingers clearly together
    },
    {
      key: "open",
      prompt: "Now open your hand wide — and hold",
      hint: "spread ALL your fingers apart",
      reduce: "max",
      valid: (lm, r) => r != null && r > 0.75 && handOpenness(lm) >= 3, // apart AND fingers extended
    },
  ];
  const BINDINGS = window.DrawMeBindings; // gesture catalog + default bindings

  // Fingerpose curl classifier for the curl-based poses (victory, fist). Defined
  // with CURLS ONLY → rotation-invariant (verified). Returns the top gesture name
  // above threshold, or null. Null if the library didn't load → gestures fall
  // back to our own finger geometry (see bindings). -> (landmarks) => name|null
  function makeCurlClassifier() {
    const FP = window.fp && (window.fp.default || window.fp);
    if (!FP) return null;
    try {
      const { GestureEstimator, GestureDescription, Finger, FingerCurl } = FP;
      const victory = new GestureDescription("victory");
      victory.addCurl(Finger.Index, FingerCurl.NoCurl, 1.0);
      victory.addCurl(Finger.Middle, FingerCurl.NoCurl, 1.0);
      for (const fg of [Finger.Ring, Finger.Pinky]) {
        victory.addCurl(fg, FingerCurl.FullCurl, 1.0);
        victory.addCurl(fg, FingerCurl.HalfCurl, 0.9);
      }
      const fist = new GestureDescription("fist");
      // index + middle must be FULLY curled (a draw-pinch only HALF-curls the
      // index, so it won't read as a fist and steal erase mid-stroke). Ring/pinky
      // are looser (they often don't fully close).
      for (const fg of [Finger.Index, Finger.Middle]) fist.addCurl(fg, FingerCurl.FullCurl, 1.0);
      for (const fg of [Finger.Ring, Finger.Pinky]) {
        fist.addCurl(fg, FingerCurl.FullCurl, 1.0);
        fist.addCurl(fg, FingerCurl.HalfCurl, 0.9);
      }
      const est = new GestureEstimator([victory, fist]);
      return (lm) => {
        if (!lm || lm.length < 21) return null;
        try {
          const found = est.estimate(
            lm.map((p) => [p.x, p.y, p.z || 0]),
            8.5,
          ).gestures;
          if (!found.length) return null;
          found.sort((a, b) => b.score - a.score);
          return found[0].name;
        } catch (_) {
          return null;
        }
      };
    } catch (_) {
      return null;
    }
  }
  const CURL_CLASSIFIER = makeCurlClassifier();

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
    settings: { enabled: true, active: true, mirror: true, preview: false, boost: true, assist: true, debug: false, minimap: true, history: true, spotlight: true, hideCamera: false, boardColor: "#14151a", color: "#ff2d55", size: 6, clearNonce: 0, undoNonce: 0, redoNonce: 0, calibNonce: 0, pinchDown: null, pinchUp: null, bindings: { ...window.DrawMeBindings.DEFAULT_BINDINGS } },
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
    // Practice-window only: seed board content so a tutorial step has something to
    // act on. Inert on real pages (nobody sends "train").
    if (msg && msg.__drawme === "train" && typeof msg.cmd === "string") {
      for (const aug of active) aug.trainSeed(msg.cmd);
      return;
    }
    if (!msg || msg.__drawme !== "config") return;
    if (msg.base) state.base = msg.base;
    const prev = { clear: state.settings.clearNonce, undo: state.settings.undoNonce, redo: state.settings.redoNonce, calib: state.settings.calibNonce };
    state.settings = { ...state.settings, ...msg.settings };
    for (const aug of active) {
      aug.applySettings(state.settings);
      if (state.settings.clearNonce !== prev.clear) aug.clear();
      if (state.settings.undoNonce !== prev.undo) aug.performUndo();
      if (state.settings.redoNonce !== prev.redo) aug.performRedo();
      if (state.settings.calibNonce !== prev.calib) aug.startCalibration();
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

  // ---- hand recognizer client (model runs in the ISOLATED world) ------------
  // The MediaPipe model CANNOT load in this MAIN world on CSP-strict sites (e.g.
  // Google Meet): dynamic import(), the wasm/model fetches, and WebAssembly
  // compilation all run in the PAGE's context here, so the PAGE's CSP blocks them.
  // So `src/content/recognizer.js` runs the model in the isolated content-script
  // world (governed by OUR extension CSP, which grants 'wasm-unsafe-eval') and we
  // talk to it over window.postMessage: we send exposure-adjusted frames, it
  // returns hand landmarks. All gesture + drawing logic stays here in MAIN.
  const recModel = { ready: false, error: null, stage: null, hands: null, requested: false, requestedAt: 0 };

  // The model lives in an extension iframe (id below) injected by the content
  // script. We post to its contentWindow directly; it posts results back to us
  // (window.parent) — handled by the __drawme_rec listener below.
  function recSend(msg, transfer) {
    const f = document.getElementById("__drawme_recognizer_host");
    const w = f && f.contentWindow;
    if (!w) return false;
    try {
      w.postMessage(msg, "*", transfer || []);
    } catch (_) {
      try {
        w.postMessage(msg, "*");
      } catch (_) {
        return false;
      }
    }
    return true;
  }
  function recRequestLoad() {
    recModel.requested = true;
    recSend({ __drawme_req: "load" });
  }
  function recFree() {
    // Ask the isolated world to release the WASM arena back to the OS.
    recModel.ready = false;
    recModel.requested = false;
    recModel.stage = null;
    recSend({ __drawme_req: "free" });
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m !== "object" || typeof m.__drawme_rec !== "string") return;
    if (m.__drawme_rec === "hello") {
      // The iframe host (re)started; if a camera is armed, (re)issue the load and
      // restart the watchdog clock (now that we know the host is actually alive).
      recModel.error = null;
      if (recModel.requested && !recModel.ready) {
        recModel.requestedAt = performance.now();
        recSend({ __drawme_req: "load" });
      }
      return;
    }
    if (m.__drawme_rec === "model") {
      if (m.status === "ready") {
        recModel.ready = true;
        recModel.error = null;
        recModel.stage = null;
        recModel.hands = m.hands || null;
      } else if (m.status === "loading") {
        recModel.ready = false;
        recModel.stage = m.stage || null;
      } else if (m.status === "error") {
        recModel.ready = false;
        recModel.error = m.error || "load failed";
        recModel.stage = null;
      } else if (m.status === "freed") {
        recModel.ready = false;
        recModel.stage = null;
        recModel.hands = null;
      }
      return;
    }
    if (m.__drawme_rec === "result") {
      recModel.hands = m.hands || recModel.hands;
      for (const aug of active) aug.onRecResult(m.landmarks || [], m.handedness || []);
    }
  });

  // ---- viewer preview panel (on-page WYSIWYG of the OUTGOING feed) -----------
  // Shows EXACTLY what viewers receive — the output canvas, with whatever mirror /
  // flip-drawing is applied — in a small draggable, resizable, collapsible panel.
  // Lets you author while watching the TRUE feed instead of the call app's mirror-
  // flipped self-tile (which is why text looked reversed). It's a separate DOM
  // overlay, NOT part of the captured stream, so viewers never see it. Shadow DOM
  // keeps the page's CSS from touching it.
  const PREVIEW_WIDTHS = [360, 560, 820]; // Small / Medium / Large (px)
  const preview = { built: false, host: null, wrap: null, canvas: null, ctx: null, sizeIdx: 1, collapsed: false, maximized: false, drag: null };

  // The host is the SINGLE width source. Critical layout props are !important so
  // neither the page's CSS nor an `all` reset can shrink it; right/bottom are NOT
  // !important so dragging can move it. Maximized ≈ fill the viewport.
  function applyPreviewSize() {
    if (!preview.host) return;
    const w = preview.maximized
      ? Math.min(1280, Math.round(window.innerWidth * 0.94))
      : PREVIEW_WIDTHS[preview.sizeIdx];
    preview.host.style.setProperty("width", w + "px", "important");
  }

  function buildPreview() {
    if (preview.built || !document.body) return;
    const host = document.createElement("div");
    host.id = "__drawme_preview_host";
    host.style.cssText =
      "position:fixed!important;z-index:2147483646!important;margin:0!important;padding:0!important;" +
      "border:0!important;box-sizing:border-box!important;max-width:96vw!important;right:16px;bottom:16px;left:auto;top:auto;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      "*{box-sizing:border-box;margin:0}" +
      ".wrap{width:100%;font-family:system-ui,-apple-system,sans-serif;background:#0b0c10;border:1px solid #2a2d3a;border-radius:10px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.5)}" +
      ".bar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#14161d;cursor:move;touch-action:none}" +
      ".dot{width:7px;height:7px;border-radius:50%;background:#35c759;flex:none}" +
      ".ttl{color:#c9cdda;font-size:12px;font-weight:600;letter-spacing:.02em;flex:1;white-space:nowrap}" +
      "button{all:unset;color:#8b90a3;font-size:15px;line-height:1;padding:4px 8px;border-radius:5px;cursor:pointer}" +
      "button:hover{color:#fff;background:#242734}" +
      "canvas{display:block;width:100%;height:auto;background:#000}" +
      ".collapsed canvas{display:none}";
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const bar = document.createElement("div");
    bar.className = "bar";
    const dot = document.createElement("span");
    dot.className = "dot";
    const ttl = document.createElement("span");
    ttl.className = "ttl";
    ttl.textContent = "Viewers see";
    const bSize = document.createElement("button");
    bSize.textContent = "⤢";
    bSize.title = "Cycle size (small / medium / large)";
    const bMax = document.createElement("button");
    bMax.textContent = "⛶";
    bMax.title = "Maximize";
    const bCollapse = document.createElement("button");
    bCollapse.textContent = "–";
    bCollapse.title = "Collapse";
    const canvas = document.createElement("canvas");
    bar.append(dot, ttl, bSize, bMax, bCollapse);
    wrap.append(bar, canvas);
    shadow.append(style, wrap);
    document.body.appendChild(host);

    // stopPropagation on the buttons so the bar's drag handler never sees the
    // press (belt-and-suspenders with the closest() check below).
    const btnGuard = (e) => e.stopPropagation();
    [bSize, bMax, bCollapse].forEach((b) => b.addEventListener("pointerdown", btnGuard));
    bSize.addEventListener("click", () => {
      preview.maximized = false;
      bMax.textContent = "⛶";
      preview.sizeIdx = (preview.sizeIdx + 1) % PREVIEW_WIDTHS.length;
      applyPreviewSize();
    });
    bMax.addEventListener("click", () => {
      preview.maximized = !preview.maximized;
      bMax.textContent = preview.maximized ? "❐" : "⛶";
      if (preview.maximized) {
        // Anchor to a corner so a viewport-wide panel stays on-screen.
        host.style.left = "3vw";
        host.style.top = "3vh";
        host.style.right = "auto";
        host.style.bottom = "auto";
      }
      applyPreviewSize();
    });
    bCollapse.addEventListener("click", () => {
      preview.collapsed = !preview.collapsed;
      wrap.classList.toggle("collapsed", preview.collapsed);
      bCollapse.textContent = preview.collapsed ? "▢" : "–";
    });
    // Keep a maximized panel fitting the window as it resizes.
    window.addEventListener("resize", () => {
      if (preview.maximized) applyPreviewSize();
    });
    // Drag by the title bar (pointer events so it works with a mouse or touch).
    bar.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      preview.drag = { x: e.clientX, y: e.clientY, r: host.getBoundingClientRect() };
      try {
        bar.setPointerCapture(e.pointerId);
      } catch (_) {}
    });
    bar.addEventListener("pointermove", (e) => {
      if (!preview.drag) return;
      const left = Math.max(4, preview.drag.r.left + (e.clientX - preview.drag.x));
      const top = Math.max(4, preview.drag.r.top + (e.clientY - preview.drag.y));
      host.style.left = left + "px";
      host.style.top = top + "px";
      host.style.right = "auto";
      host.style.bottom = "auto";
    });
    const endDrag = (e) => {
      preview.drag = null;
      try {
        bar.releasePointerCapture(e.pointerId);
      } catch (_) {}
    };
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);

    Object.assign(preview, { built: true, host, wrap, canvas, ctx: canvas.getContext("2d", { alpha: false }) });
    applyPreviewSize();
  }

  function showPreview(on) {
    if (on) {
      buildPreview();
      if (preview.host) preview.host.style.display = "";
    } else if (preview.host) {
      preview.host.style.display = "none";
    }
  }

  // Copy the outgoing frame into the panel (mirrors exactly what viewers get).
  // Bitmap size tracks the canvas's ACTUAL rendered width so it stays crisp at
  // whatever size the panel is, and always matches what's displayed.
  function updatePreview(src) {
    if (!preview.built || !preview.host || preview.host.style.display === "none" || preview.collapsed) return;
    if (!src.width || !src.height) return;
    const w = Math.round(preview.canvas.clientWidth) || PREVIEW_WIDTHS[preview.sizeIdx];
    const h = Math.round((w * src.height) / src.width);
    if (preview.canvas.width !== w || preview.canvas.height !== h) {
      preview.canvas.width = w;
      preview.canvas.height = h;
    }
    preview.ctx.drawImage(src, 0, 0, w, h);
  }

  // ---- augmentor: wraps one real stream, produces a canvas stream -----------
  class Augmentor {
    constructor(realStream, settings) {
      this.real = realStream;
      this.settings = { ...settings };
      this.ctrl = new GestureController(BINDINGS.GESTURES, { curlClassifier: CURL_CLASSIFIER });
      this.strokes = new Strokes();
      this.hist = new UndoHistory({ max: 60 }); // per-action undo/redo
      this.hist.init(this.strokes.snapshot());
      this.dirty = false; // board changed since the last commit
      this.history = []; // cleared-board thumbnails { el, url, strokes } for the strip
      this.histDrag = null; // five-finger drag from the strip: { idx, at } or null
      this.historyHover = -1; // thumbnail highlighted by hovering (grab candidate)
      this.historyMode = false; // strip interaction is GATED until activated
      this.historyModeAt = 0; // last activation/interaction (for auto-close)
      this.historyDragReady = false; // must release the activating pinch before dragging
      this.pinchPump = new DoubleTap({ window: 1100, minGap: 100 }); // double five-pinch = open history
      this.raf = null;
      this.cursor = null;
      this.gestureName = null;
      this.gestureScore = 0;
      this.curMode = "idle";
      this.curRatio = null;
      this.curFp = null; // Fingerpose curl label (debug HUD)
      this.aimPt = null; // two-finger aim point (grab preview), or null
      this.action = null; // current action (from the bindings map)
      this.grabX = null; // one-fist grab: { snap, start } (absolute transform)
      this.xform = null; // two-hand transform: { snap, center, len, angle }
      this.transformA = null; // two-hand grab points (indicator)
      this.transformB = null;
      this.transformCenter = null; // transform pivot (indicator)
      this.txSpread = null; // last { a, b } two-hand spreads (freeze-on-release)
      this.shapeGrab = null; // move-one-shape: { i, last } (picked item + last pointer)
      this.selection = []; // indices of marquee-selected shapes (for bulk move)
      this.selRect = null; // { x0, y0, x1, y1 } while dragging a selection rectangle
      this.escPath = []; // recent pointer path (wild-shake = escape)
      this.escFlash = 0; // timestamp of the last shake-escape (for a flash)
      this.calib = null; // active pinch-calibration state, or null
      this.calibDone = 0; // timestamp of the last successful calibration (flash)
      this.swipe = new SwipeDetector(); // index-point + swipe = clear all
      this.fistClench = new FistClench(); // double fist-clench = compound gesture
      this.prevGesture = "none"; // resolved gesture last frame (for fire-once actions)
      this.handInfo = null; // { label:"Left"|"Right", score } of the active hand
      this.detHist = []; // recent { t, on } detection samples (rolling "seen %")
      this.hands = []; // current frame's landmark sets (for the hand-glow spotlight)
      // Latest hand-detection result from the isolated-world recognizer, plus the
      // in-flight gate so we send one frame at a time (inference-bound, no backlog).
      this.latestResult = null; // { landmarks, handedness } — lags render by ~1 frame
      this.recFrameInFlight = false;
      this.recSentAt = 0;
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

      // Tiny canvas for metering scene luminance PER-TILE (spatial auto-exposure).
      // willReadFrequently: only ~48x36 pixels, read every few frames.
      this.lum = document.createElement("canvas");
      this.lum.width = 48;
      this.lum.height = 36;
      this.lumCtx = this.lum.getContext("2d", { alpha: false, willReadFrequently: true });
      this.GX = 8; // exposure grid columns (metered fine; effective coarseness auto-tunes)
      this.GY = 6; // rows
      this.gainGrid = new Float32Array(this.GX * this.GY).fill(1.3); // per-tile gain (EMA)
      this.gainSmooth = new Float32Array(this.GX * this.GY).fill(1.3); // spatially smoothed
      this.autoContrast = 1.15;
      this.lumFrame = 0;
    }

    // Re-meter each tile and ease its brightness gain toward a target, so a dim
    // REGION gets lifted while a bright one isn't blown out (which would clip the
    // detail the palm detector needs). Temporal EMA + a 3x3 spatial blur keep the
    // gain map GRADUAL across the scene (no hard seams). This is what lets a hand
    // be detected wherever it is, even where the frame is unevenly lit.
    updateGainGrid() {
      const s = this.lum;
      const GX = this.GX;
      const GY = this.GY;
      this.lumCtx.drawImage(this.video, 0, 0, s.width, s.height);
      const d = this.lumCtx.getImageData(0, 0, s.width, s.height).data;
      const TARGET = 140;
      let overall = 0;
      for (let ty = 0; ty < GY; ty++) {
        for (let tx = 0; tx < GX; tx++) {
          const x0 = Math.floor((tx * s.width) / GX);
          const x1 = Math.floor(((tx + 1) * s.width) / GX);
          const y0 = Math.floor((ty * s.height) / GY);
          const y1 = Math.floor(((ty + 1) * s.height) / GY);
          let sum = 0;
          let n = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const i = (y * s.width + x) * 4;
              sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              n++;
            }
          }
          const lum = n ? sum / n : TARGET;
          overall += lum;
          const gain = Math.max(0.7, Math.min(2.3, TARGET / Math.max(10, lum)));
          const idx = ty * GX + tx;
          this.gainGrid[idx] = this.gainGrid[idx] * 0.85 + gain * 0.15;
        }
      }
      overall /= GX * GY;
      const rawC = overall < 90 ? 1.3 : overall > 170 ? 1.0 : 1.15;
      this.autoContrast = this.autoContrast * 0.85 + rawC * 0.15;
      // AUTO grid coarseness: how many 3x3 blur passes = how UNEVEN the gains are.
      // Uneven light (high variance) → few passes, keep local detail (fine grid).
      // Uniform light → more passes, smoother (effectively coarse). Self-tuning.
      let mean = 0;
      for (const v of this.gainGrid) mean += v;
      mean /= this.gainGrid.length;
      let varc = 0;
      for (const v of this.gainGrid) varc += (v - mean) * (v - mean);
      varc /= this.gainGrid.length;
      const passes = varc > 0.2 ? 2 : varc > 0.06 ? 3 : 4; // smoother → fewer seams
      this.gainSmooth.set(this.gainGrid);
      const tmp = this._gainTmp || (this._gainTmp = new Float32Array(GX * GY));
      for (let p = 0; p < passes; p++) {
        tmp.set(this.gainSmooth);
        for (let ty = 0; ty < GY; ty++) {
          for (let tx = 0; tx < GX; tx++) {
            let sum = 0;
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = tx + dx;
                const ny = ty + dy;
                if (nx >= 0 && nx < GX && ny >= 0 && ny < GY) {
                  sum += tmp[ny * GX + nx];
                  n++;
                }
              }
            }
            this.gainSmooth[ty * GX + tx] = sum / n;
          }
        }
      }
    }

    applySettings(s) {
      this.settings = { ...this.settings, ...s };
      // apply calibrated pinch thresholds live (null = keep the controller default)
      if (this.ctrl) {
        if (typeof s.pinchDown === "number") this.ctrl.DOWN_T = s.pinchDown;
        if (typeof s.pinchUp === "number") this.ctrl.UP_T = s.pinchUp;
      }
      showPreview(!!this.settings.preview); // on-page "what viewers see" panel
    }
    clear() {
      this.clearBoard(performance.now()); // saves a thumbnail + one undo step
    }

    // Practice-window helper: seed the board so a tutorial step has real content to
    // act on (a shape to move/select/transform, a scribble to erase, a saved board
    // in history to restore, etc.). Uses the real Strokes model, so it's genuine.
    trainSeed(cmd) {
      const now = performance.now();
      const aspect = this.canvas.width / Math.max(1, this.canvas.height);
      const circle = (cx, cy, col) => {
        this.strokes.begin({ x: cx + 0.07, y: cy }, col, 6);
        for (let a = 0; a <= Math.PI * 2 + 0.25; a += 0.3) this.strokes.extend({ x: cx + 0.07 * Math.cos(a), y: cy + 0.09 * Math.sin(a) });
        this.strokes.end(true, aspect, now);
      };
      if (cmd === "shapes" || cmd === "select") {
        this.strokes.clear();
        this.selection = [];
        circle(0.4, 0.45, "#0a84ff");
        circle(0.6, 0.45, "#35c759");
        if (cmd === "select") this.selection = [0, 1];
      } else if (cmd === "scribble") {
        this.strokes.clear();
        this.selection = [];
        this.strokes.begin({ x: 0.42, y: 0.42 }, "#ffcc00", 9);
        for (const [x, y] of [[0.5, 0.55], [0.58, 0.42], [0.5, 0.56], [0.62, 0.5]]) this.strokes.extend({ x, y });
        this.strokes.end(false, aspect, now);
      } else if (cmd === "history") {
        // put a board up, then clear it INTO history so the strip has a thumbnail
        // (does NOT open history mode — the "open history" step teaches that).
        this.strokes.clear();
        this.selection = [];
        circle(0.5, 0.45, "#ff2d55");
        this.clearBoard(now);
        return;
      } else if (cmd === "historyopen") {
        // keep-alive for the RESTORE step: hold history mode open + drag-ready.
        if (this.history.length) {
          this.historyMode = true;
          this.historyDragReady = true;
          this.historyModeAt = now;
        }
        return;
      }
      this.dirty = true;
      this.maybeCommit();
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

      // The model loads lazily in the isolated world once drawing is armed (the
      // loop requests it via recRequestLoad). Frames pass through until it's ready.

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
      if (action !== "grabShape") {
        this.shapeGrab = null;
        if (this.selRect) {
          // marquee released → finalize which shapes are selected
          this.selection = this.strokes.selectInRect(this.selRect.x0, this.selRect.y0, this.selRect.x1, this.selRect.y1);
          this.selRect = null;
        }
      }
      // structural edits invalidate the selection (indices shift / content
      // changes). NOT transform — it now operates ON the selection.
      if (action === "draw" || action === "erase" || action === "clear" || action === "grab") {
        this.selection = [];
      }
      if (action !== "transform") {
        this.xform = null;
        this.transformA = null;
        this.transformB = null;
        this.txSpread = null;
      }
      // History drag ended (pinch released → action changed): restore if it was
      // pulled onto the board, otherwise just drop the floating preview. Without
      // this, releasing never restored AND the preview never cleared.
      if (action !== "historyDrag") this.finishHistoryDrag(!!lms);
      if (action !== "erase") this.swipe.reset();

      if (action === "draw") this.actDraw(g);
      else if (action === "erase") this.actErase(g, ts);
      else if (action === "grab") this.actGrab(g);
      else if (action === "grabShape") this.actGrabShape(g, lms, aspect);
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
      // Inert unless history mode is open AND the activating pinch was released.
      if (!this.historyMode || !this.historyDragReady) {
        this.cursor = { x: g.point.x, y: g.point.y, mode: "idle", active: false };
        return;
      }
      this.historyModeAt = performance.now(); // interacting → keep mode alive
      if (!this.histDrag) {
        // Grab the thumbnail you HIGHLIGHTED by hovering, OR — more forgiving — the
        // one you pinched directly on (the five-finger cluster is imprecise, so a
        // generous pad). Nothing under either → grabs nothing.
        const p = { x: g.point.x, y: g.point.y };
        let idx = this.historyHover;
        if (idx < 0) idx = this.historyAt(p, 26);
        this.histDrag = { idx, from: p, at: { ...p }, path: [], cancelled: false };
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
      // Restore only on a DELIBERATE drag: picked, released off the right-side
      // zone AND pulled a real distance from where it was grabbed. This stops an
      // incidental five-pinch near the strip from restoring a board.
      // Restore = picked + pulled a real distance LEFT onto the board (the strip
      // is on the right). Decoupled from any edge zone, so a generous hover area
      // doesn't shrink the restore target.
      // Restore if it was pulled a real distance LEFT onto the board (the strip is
      // on the right). Simple + forgiving: not tied to the hover zone, and doesn't
      // require the hand on the exact release frame (opening the pinch can blip it).
      // Not dragged left (or dragged back to the strip) → cancel.
      const moved = Math.hypot(d.at.x - d.from.x, d.at.y - d.from.y);
      const draggedOntoBoard = d.idx >= 0 && moved > 0.16 && d.from.x - d.at.x > 0.1;
      if (draggedOntoBoard) {
        if (this.restoreFromHistory(d.idx)) {
          this.clearFlash = performance.now();
          this.historyMode = false; // task done → close history mode
        }
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

    // --- pinch calibration (guided; measures YOUR hand) ---
    startCalibration() {
      this.calib = { i: 0, t0: 0, samples: [], values: {} };
    }
    // Run one calibration frame. Progress is driven by HAND-PRESENT samples, not
    // wall-clock — so it WAITS for you to raise your hand and hold the pose, and
    // only advances once it has enough samples. Returns true while calibrating.
    runCalibration(g, lms, ts) {
      const cal = this.calib;
      if (!cal) return false;
      const NEED = 40; // valid-pose samples needed to lock a value
      const SETTLE = 10; // ignore the first few valid frames (settling into pose)
      const step = CALIB_STEPS[cal.i];
      const poseOk = g.present && typeof g.ratio === "number" && lms && step.valid(lms, g.ratio);
      cal.poseOk = poseOk;
      cal.hand = g.present;
      // ONLY record while the correct pose is actually held. Doing nothing (or the
      // wrong pose) → not valid → no samples → the bar stays put.
      if (poseOk) {
        cal.seen = (cal.seen || 0) + 1;
        if (cal.seen > SETTLE) cal.samples.push(g.ratio);
      }
      cal.progress = Math.min(1, cal.samples.length / NEED);
      if (cal.samples.length >= NEED) {
        cal.values[step.key] = step.reduce === "min" ? Math.min(...cal.samples) : Math.max(...cal.samples);
        cal.i++;
        cal.samples = [];
        cal.seen = 0;
        cal.progress = 0;
        if (cal.i >= CALIB_STEPS.length) this.finishCalibration();
      }
      this.cursor = null;
      return true;
    }
    finishCalibration() {
      const v = this.calib.values;
      if (typeof v.pinch === "number" && typeof v.open === "number" && v.open > v.pinch + 0.05) {
        const gap = v.open - v.pinch;
        const downT = +(v.pinch + gap * 0.3).toFixed(3); // engage a bit above your pinch
        const upT = +(v.pinch + gap * 0.6).toFixed(3); // release below your open
        this.ctrl.DOWN_T = downT;
        this.ctrl.UP_T = upT;
        this.calibDone = performance.now();
        try {
          window.postMessage(
            { __drawme: "calibrated", thresholds: { pinchDown: downT, pinchUp: upT } },
            window.location.origin === "null" ? "*" : window.location.origin,
          );
        } catch (_) {
          /* best-effort persistence */
        }
      }
      this.calib = null;
    }
    // On-canvas calibration wizard.
    drawCalibration(ctx, canvas) {
      const cal = this.calib;
      if (!cal) return;
      const W = canvas.width;
      const H = canvas.height;
      ctx.save();
      ctx.fillStyle = "rgba(10,12,18,0.72)";
      ctx.fillRect(0, 0, W, H);
      const step = CALIB_STEPS[cal.i];
      ctx.textAlign = "center";
      ctx.fillStyle = "#c9cdda";
      ctx.font = `${Math.round(W * 0.02)}px system-ui, sans-serif`;
      ctx.fillText(`Calibrating · step ${cal.i + 1} of ${CALIB_STEPS.length}`, W / 2, H * 0.4);
      ctx.fillStyle = "#ffffff";
      ctx.font = `${Math.round(W * 0.033)}px system-ui, sans-serif`;
      ctx.fillText(step.prompt, W / 2, H * 0.48);
      // progress bar driven by collected samples; hint if no hand yet
      const p = cal.progress || 0;
      const bw = W * 0.4;
      const bx = W / 2 - bw / 2;
      const by = H * 0.54;
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, 12);
      ctx.fillStyle = "#35c759";
      ctx.fillRect(bx, by, bw * p, 12);
      // status: green "detected, hold" only when the correct pose is verified
      const msg = !cal.hand ? "raise your hand into view" : cal.poseOk ? "✓ pose detected — hold steady" : step.hint;
      ctx.fillStyle = cal.poseOk ? "rgba(53,199,89,0.95)" : "rgba(255,200,80,0.95)";
      ctx.font = `${Math.round(W * 0.02)}px system-ui, sans-serif`;
      ctx.fillText(msg, W / 2, H * 0.6);
      ctx.restore();
    }

    // Wild-shake ESCAPE: bail out of any in-progress action — cancel the current
    // stroke, drop the selection/marquee, release any grab/transform, close
    // history mode. Committed drawing is untouched (undo covers that).
    escape() {
      this.strokes.cancelCurrent();
      this.selection = [];
      this.selRect = null;
      this.shapeGrab = null;
      this.grabX = null;
      this.xform = null;
      this.transformA = null;
      this.transformB = null;
      this.txSpread = null;
      this.histDrag = null;
      this.historyMode = false;
      this.dirty = false;
      this.escFlash = performance.now();
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

    // Closed fist = PAN the whole board: translate every stroke by the hand's
    // movement (incremental, so no settled/freeze machinery needed — that gate is
    // what made the old depth-grab do nothing here). Pure pan, no zoom/rotate.
    actGrab(g) {
      if (!g.point) return;
      if (!this.grabX) {
        this.grabX = { last: { x: g.point.x, y: g.point.y } };
      } else {
        const dx = g.point.x - this.grabX.last.x;
        const dy = g.point.y - this.grabX.last.y;
        if (dx || dy) {
          this.strokes.translateAll(dx, dy);
          this.dirty = true;
        }
        this.grabX.last = { x: g.point.x, y: g.point.y };
      }
      this.cursor = { x: g.point.x, y: g.point.y, mode: "transform", active: true };
    }

    // Victory (grab). Decided by where you START:
    //  • on a SHAPE  → move it (or the whole selection if that shape is selected).
    //                  THUMB OUT = translate; THUMB BENT = rotate around the group
    //                  centre by your wrist twist (a modifier, no new gesture).
    //  • on EMPTY    → drag a marquee rectangle; on release its contents are
    //                  selected (finalised in dispatch).
    // Angle the "V" points (base of index+middle → their tips), mirror-aware. It
    // spans a full range and tracks the hand's rotation crisply — a much better
    // rotation input than wrist-roll.
    twoFingerAngle(lms) {
      const bx = (lms[5].x + lms[9].x) / 2;
      const by = (lms[5].y + lms[9].y) / 2;
      const tx = (lms[8].x + lms[12].x) / 2;
      const ty = (lms[8].y + lms[12].y) / 2;
      let dx = tx - bx;
      if (this.settings.mirror) dx = -dx;
      return Math.atan2(ty - by, dx);
    }
    actGrabShape(g, lms, aspect) {
      if (!g.point) return;
      const angle = lms ? this.twoFingerAngle(lms) : 0;
      if (!this.shapeGrab) {
        const i = this.strokes.hitTest(g.point, 0.05);
        if (i >= 0) {
          const group = this.selection.includes(i) ? this.selection.slice() : null;
          const idxs = group || [i];
          const b = this.strokes.itemsBounds(idxs);
          const pivot = b ? { x: (b.minx + b.maxx) / 2, y: (b.miny + b.maxy) / 2 } : { x: g.point.x, y: g.point.y };
          this.shapeGrab = { i, group, marquee: false, last: { x: g.point.x, y: g.point.y }, lastAngle: angle, pivot };
          if (!group) this.selection = []; // grabbed a shape outside the selection
        } else {
          this.shapeGrab = { i: -1, marquee: true, last: { x: g.point.x, y: g.point.y } };
          this.selRect = { x0: g.point.x, y0: g.point.y, x1: g.point.x, y1: g.point.y };
          this.selection = [];
        }
      } else if (this.shapeGrab.marquee) {
        this.selRect.x1 = g.point.x;
        this.selRect.y1 = g.point.y;
      } else if (this.shapeGrab.i >= 0) {
        const idxs = this.shapeGrab.group || [this.shapeGrab.i];
        // Grab = MOVE and ROTATE together (like holding the shape). Rotate by the
        // V's twist above a small noise floor (so a steady-orientation slide is a
        // clean move); translate by the hand's movement every frame. No fragile
        // thumb detection — nothing to occlude.
        if (lms) {
          let dA = angle - this.shapeGrab.lastAngle;
          while (dA > Math.PI) dA -= 2 * Math.PI;
          while (dA < -Math.PI) dA += 2 * Math.PI;
          if (Math.abs(dA) > 0.02) {
            for (const idx of idxs) this.strokes.transformItem(idx, 1, dA, this.shapeGrab.pivot, aspect);
            this.shapeGrab.lastAngle = angle; // only advance the baseline when we rotate
          }
        }
        const dx = g.point.x - this.shapeGrab.last.x;
        const dy = g.point.y - this.shapeGrab.last.y;
        for (const idx of idxs) this.strokes.translate(idx, dx, dy);
        this.shapeGrab.pivot.x += dx; // rotation pivot rides along with the move
        this.shapeGrab.pivot.y += dy;
        this.shapeGrab.last = { x: g.point.x, y: g.point.y };
        this.dirty = true;
      }
      const moving = this.shapeGrab.i >= 0;
      this.cursor = { x: g.point.x, y: g.point.y, mode: moving ? "move" : "idle", active: moving || this.shapeGrab.marquee };
    }

    // Two five-finger pinches: distance = scale, angle = rotate, midpoint = pan —
    // the classic two-point transform, absolute from a fixed-pivot snapshot. The
    // between-hands angle has FULL range (and you can re-grip), so this is the
    // proper way to rotate freely — no single-wrist limit. If shapes are SELECTED
    // it transforms just the SELECTION (around its own centre); else the whole
    // canvas. Commits only while BOTH hands hold steadily (tf.settled).
    actTransform(tf, aspect) {
      const { pa, pb } = tf;
      const center = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1e-6;
      const angle = Math.atan2(pb.y - pa.y, pb.x - pa.x);
      if (!this.xform) {
        const sel = this.selection.slice();
        const b = sel.length ? this.strokes.itemsBounds(sel) : null;
        const pivot = b ? { x: (b.minx + b.maxx) / 2, y: (b.miny + b.maxy) / 2 } : center;
        this.xform = { snap: this.strokes.snapshot(), center, len, angle, sel, pivot };
      } else if (tf.settled !== false) {
        const x0 = this.xform;
        this.strokes.restore(x0.snap);
        const s = len / x0.len;
        const r = angle - x0.angle;
        const px = center.x - x0.center.x;
        const py = center.y - x0.center.y;
        if (x0.sel.length) {
          for (const idx of x0.sel) this.strokes.transformItem(idx, s, r, x0.pivot, aspect);
          for (const idx of x0.sel) this.strokes.translate(idx, px, py);
        } else {
          this.strokes.transformAll(s, r, x0.center, aspect);
          this.strokes.translateAll(px, py);
        }
        this.dirty = true;
      }
      this.transformA = pa;
      this.transformB = pb;
      this.transformCenter = this.xform.pivot || this.xform.center; // pivot = selection centre
      this.cursor = { x: center.x, y: center.y, mode: "transform", active: true };
    }

    // Marquee rectangle (while dragging a selection) + outlines around the
    // currently-selected shapes, so you can see the group before/while moving it.
    drawSelection(ctx, canvas) {
      const W = canvas.width;
      const H = canvas.height;
      ctx.save();
      if (this.selRect) {
        const x = Math.min(this.selRect.x0, this.selRect.x1) * W;
        const y = Math.min(this.selRect.y0, this.selRect.y1) * H;
        const w = Math.abs(this.selRect.x1 - this.selRect.x0) * W;
        const h = Math.abs(this.selRect.y1 - this.selRect.y0) * H;
        ctx.fillStyle = "rgba(120,200,255,0.10)";
        ctx.fillRect(x, y, w, h);
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(120,200,255,0.95)";
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
      }
      if (this.selection.length) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(255,210,60,0.85)"; // amber = selected
        for (const i of this.selection) {
          const b = this.strokes.itemsBounds([i]);
          if (!b) continue;
          ctx.strokeRect(b.minx * W - 3, b.miny * H - 3, (b.maxx - b.minx) * W + 6, (b.maxy - b.miny) * H + 6);
        }
      }
      ctx.restore();
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

      // BOTH hands as dots, so you can locate each on the map. The primary hand
      // uses its precise gesture cursor (pen colour when active); any other hand
      // uses its palm centre (cyan). Palm point is mirror-aware, like the strokes.
      const dot = (px, py, fill) => {
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.stroke();
      };
      if (this.cursor) dot(mx(this.cursor.x), my(this.cursor.y), this.cursor.active ? this.settings.color : "rgba(255,255,255,0.9)");
      for (let i = 1; i < this.hands.length; i++) {
        const lm = this.hands[i];
        if (!lm || lm.length < 21) continue;
        let cx = 0;
        let cy = 0;
        for (const j of [0, 5, 9, 13, 17]) {
          cx += lm[j].x;
          cy += lm[j].y;
        }
        cx /= 5;
        cy /= 5;
        dot(mx(this.settings.mirror ? 1 - cx : cx), my(cy), "rgba(110,220,255,0.95)");
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
      // Generous reach — history mode is already deliberately open, so you can
      // hover from a comfortable central-right position (no reaching the edge).
      if (px < rects[0].x - W * 0.42) return -1;
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
      // Hover-highlight only when history mode is OPEN and the hand is idle — so
      // the strip is inert (just visible) during normal drawing.
      if (!this.histDrag) {
        this.historyHover =
          this.historyMode && this.cursor && !this.cursor.active ? this.historyHoverAt(this.cursor) : -1;
      }
      const dragIdx = this.histDrag && this.histDrag.idx >= 0 ? this.histDrag.idx : -1;
      const hi = dragIdx >= 0 ? dragIdx : this.historyHover;
      const active = this.historyMode;
      // dragging a preview back OVER the strip = "release to put it back"
      const dragBack = dragIdx >= 0 && this.historyHoverAt(this.histDrag.at) >= 0;
      ctx.save();
      // strip cue: amber "put it back" when a drag hovers it, else green "active"
      if ((active || dragIdx >= 0) && rects.length) {
        const top = rects[0];
        const bot = rects[rects.length - 1];
        ctx.strokeStyle = dragBack ? "rgba(255,180,60,0.95)" : "rgba(53,199,89,0.9)";
        ctx.lineWidth = dragBack ? 3 : 2;
        ctx.strokeRect(top.x - 6, top.y - 6, top.w + 12, bot.y + bot.h - top.y + 12);
        if (dragBack) {
          ctx.fillStyle = "rgba(255,180,60,0.95)";
          ctx.font = `${Math.max(10, Math.round(top.w * 0.16))}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText("↩ put back", top.x + top.w / 2, top.y - 12);
        }
      }
      for (const r of rects) {
        const item = this.history[r.i];
        ctx.fillStyle = "rgba(20,21,26,0.6)";
        ctx.fillRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
        if (item.el && (item.el.width || item.el.complete)) ctx.drawImage(item.el, r.x, r.y, r.w, r.h);
        const on = r.i === hi;
        ctx.strokeStyle = on ? "#ffd23f" : active ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.28)";
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
      // green only when a release NOW would actually restore (pulled left onto
      // the board, far enough) — so the preview never promises a restore it won't do.
      const moved = Math.hypot(d.at.x - d.from.x, d.at.y - d.from.y);
      const willRestore = moved > 0.16 && d.from.x - d.at.x > 0.1;
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "rgba(20,21,26,0.9)";
      ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
      ctx.drawImage(item.el, x, y, w, h);
      // green = will restore · amber = over strip (release to put back) · white = neither
      ctx.strokeStyle = willRestore ? "#35c759" : overBar ? "#ffb43c" : "rgba(255,255,255,0.5)";
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
        this.hudLines(ctx, canvas, [["STATUS", "disarmed · arm from the toolbar popup", "#8b90a3"]]);
        return;
      }
      if (!recModel.ready) {
        const msg = recModel.error
          ? `model failed: ${recModel.error}`
          : `loading model…${recModel.stage ? ` (${recModel.stage})` : ""}`;
        this.hudLines(ctx, canvas, [["DETECT", msg, recModel.error ? "#ff453a" : "#ffcc00"]]);
        return;
      }
      // DETECT = does the model see a HAND at all (separate from any gesture).
      // "seen X%" is the fraction of the last ~1.5s where a hand was found, so a
      // low number = the detector is dropping your hand, not a gesture problem.
      const seen = this.detHist.length ? Math.round((100 * this.detHist.filter((d) => d.on).length) / this.detHist.length) : 0;
      const nHands = this.hands.length;
      const detect = hand
        ? ["DETECT", `${nHands} hand${nHands > 1 ? "s" : ""} · seen ${seen}%`, nHands >= 2 ? "#35c759" : "#c9cdda"]
        : ["DETECT", `searching… no hand · seen ${seen}%`, "#ffcc00"];
      const action = (this.curMode || "idle").toUpperCase();
      const pinch = this.curRatio != null ? this.curRatio.toFixed(2) : "-";
      const lines = [
        detect,
        ["GESTURE", hand ? this.gestureName || "—" : "—", "#ffffff"],
        ["ACTION", action, this.modeColor(this.curMode)],
        ["pinch", `${pinch}  (draw < 0.40)`, "#c9cdda"],
      ];
      if (CURL_CLASSIFIER) lines.push(["curl/fp", hand ? this.curFp || "—" : "—", "#8fd4ff"]);
      if (this.settings.boost) {
        let gmn = 9;
        let gmx = 0;
        for (const v of this.gainSmooth) {
          gmn = Math.min(gmn, v);
          gmx = Math.max(gmx, v);
        }
        lines.push(["auto-exp", `gain ${gmn.toFixed(2)}–${gmx.toFixed(2)} · ${this.autoContrast.toFixed(2)}c`, "#c9cdda"]);
      }
      this.hudLines(ctx, canvas, lines);
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
      // dim the camera so ink pops — but NOT in whiteboard mode (board's already
      // solid; dimming it just muddies the colours). Keep the hand glow either way.
      if (!this.settings.hideCamera) {
        ctx.fillStyle = "rgba(0,0,0,0.26)";
        ctx.fillRect(0, 0, W, H);
      }
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
    // A landmark result arrived from the isolated recognizer → cache it and open
    // the gate for the next frame.
    onRecResult(landmarks, handedness) {
      this.recFrameInFlight = false;
      this.latestResult = { landmarks, handedness };
    }

    // Ship one exposure-adjusted frame to the isolated-world recognizer. One at a
    // time (in-flight gate) so inference paces itself and we never build a backlog.
    // ImageBitmap is transferred (zero-copy) across the world boundary.
    sendInferenceFrame(ts) {
      if (this.recFrameInFlight || this.stopped) return;
      let src;
      try {
        src = this.inferenceSource();
      } catch (_) {
        return;
      }
      if (!src) return;
      this.recFrameInFlight = true;
      this.recSentAt = ts;
      createImageBitmap(src)
        .then((bmp) => {
          if (this.stopped) {
            if (bmp.close) bmp.close();
            this.recFrameInFlight = false;
            return;
          }
          // Prefer zero-copy transfer; if the world boundary refuses it, fall back
          // to a structured clone so a strict browser can't stall inference.
          try {
            recSend({ __drawme_req: "frame", bitmap: bmp, ts }, [bmp]);
          } catch (_) {
            try {
              recSend({ __drawme_req: "frame", bitmap: bmp, ts });
            } catch (_) {
              this.recFrameInFlight = false;
            }
          }
        })
        .catch(() => {
          this.recFrameInFlight = false;
        });
    }

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
      // Re-meter the tile gains every few frames (adapts as lighting changes).
      if ((this.lumFrame++ & 3) === 0) this.updateGainGrid();
      // Paint the model image tile-by-tile, each with its OWN brightness — so a
      // dim region of the window is lifted and a bright one isn't blown out. The
      // smoothed grid makes the gain vary gradually between regions. Tiles overlap
      // 1px so there are no gaps.
      const GX = this.GX;
      const GY = this.GY;
      const c = this.autoContrast.toFixed(3);
      for (let ty = 0; ty < GY; ty++) {
        for (let tx = 0; tx < GX; tx++) {
          const dx = Math.floor((tx * iw) / GX);
          const dw = Math.floor(((tx + 1) * iw) / GX) - dx + 1;
          const dy = Math.floor((ty * ih) / GY);
          const dh = Math.floor(((ty + 1) * ih) / GY) - dy + 1;
          this.infCtx.filter = `brightness(${this.gainSmooth[ty * GX + tx].toFixed(3)}) contrast(${c})`;
          this.infCtx.drawImage(this.video, (tx * vw) / GX, (ty * vh) / GY, vw / GX, vh / GY, dx, dy, dw, dh);
        }
      }
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

      // Layer 0: camera (mirrored for a natural selfie view) — OR, in whiteboard
      // mode, a solid board instead of the camera (hand tracking still runs off
      // the video element; we just don't paint the picture into the output).
      if (this.settings.hideCamera) {
        ctx.fillStyle = this.settings.boardColor || "#14151a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.save();
        if (this.settings.mirror) {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      }

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
      if (this.settings.active) {
        const ts = performance.now();
        if (!recModel.ready) {
          // Not loaded yet → ask the iframe host to load it (once).
          if (!recModel.requested) {
            recRequestLoad();
            recModel.requestedAt = ts;
          } else if (!recModel.error && !recModel.stage && recModel.requestedAt && ts - recModel.requestedAt > 6000) {
            // The iframe never even reported "loading" → it didn't load at all
            // (page likely blocked the extension frame). Surface it, don't spin.
            recModel.error = "recognizer host did not load (page may block the extension frame)";
          }
        } else {
          // Unstick the in-flight gate if a result never came back (e.g. the model
          // was freed between send and receive), then send this frame for inference.
          if (this.recFrameInFlight && ts - this.recSentAt > 400) this.recFrameInFlight = false;
          this.sendInferenceFrame(ts);
        }
        // Use the most recent landmarks the isolated recognizer returned (~1 frame
        // of lag; imperceptible). All gesture logic below is unchanged.
        const res = this.latestResult;
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
        this.curFp = g.fp; // Fingerpose curl label (for the debug HUD)
        if (this.calib && this.runCalibration(g, lms, ts)) {
          // calibrating: measure only, no drawing/actions this frame
        } else {
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

        // Double five-finger-pinch (ONE hand) OPENS history mode — the strip is
        // inert until then, so the right side stays free for drawing. It
        // auto-closes after inactivity. `historyDragReady` makes you release the
        // activating pinch before a drag can begin (so the opener doesn't grab).
        // RESET (not just feed false) whenever it's not exactly one hand, so a
        // TWO-hand five-pinch — whose entry flickers 1→2→1 hands — can't fake the
        // two pulses and open history.
        if (allHands.length >= 2) {
          this.pinchPump.reset(); // two hands → can't be a single-hand double-pinch
        } else {
          // 1 hand → feed five.on; 0 hands (brief loss) → feed false but DON'T reset,
          // so a one-frame tracking blip between the two pinches can't wipe it.
          const fiveOn = allHands.length === 1 && lms ? fivePinch(lms).on : false;
          if (this.pinchPump.update(fiveOn, ts)) {
            this.historyMode = true;
            this.historyModeAt = ts;
            this.historyDragReady = false;
          }
        }
        if (this.historyMode) {
          if (gesture !== "fivePinch") this.historyDragReady = true; // released → ok to drag
          if (!this.histDrag && ts - this.historyModeAt > HISTORY_MODE_MS) this.historyMode = false;
        }

        // Resolved-gesture change edge (fire-once actions like clear read this,
        // since g.changed only reflects the single-hand controller, not overrides).
        this.gestureChanged = gesture !== this.prevGesture;
        this.prevGesture = gesture;

        const bindings = { ...BINDINGS.DEFAULT_BINDINGS, ...(this.settings.bindings || {}) };
        const action = bindings[gesture] || null;

        // Wild shake = ESCAPE (a deliberate violent zigzag; the isShake gate is
        // far above normal drawing motion). Cancels in-progress state, skips this
        // frame's action so the shake itself doesn't draw/act.
        if (g.point) {
          this.escPath.push({ x: g.point.x, y: g.point.y, t: ts });
          while (this.escPath.length && ts - this.escPath[0].t > 450) this.escPath.shift();
        } else {
          this.escPath = [];
        }
        if (g.point && isShake(this.escPath)) {
          this.escape();
          this.escPath = [];
        } else {
          this.dispatch(action, g, gesture, twoHand, lms, aspect, ts);
          this.maybeCommit(); // one undo step per settled action
        }
        } // end: not calibrating
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
        this.pinchPump.reset();
        this.prevGesture = "none";
        this.hands = [];
        this.histDrag = null; // disarm mid-drag = discard
        this.historyMode = false;
        this.selRect = null;
        this.selection = [];
        this.escPath = [];
        this.latestResult = null; // drop stale landmarks so no ghost hand lingers
        this.recFrameInFlight = false;
      }

      // (No idle auto-disarm — drawing stays armed until you toggle it off with
      // the popup switch or Alt+Shift+D.)

      // Layer 0.5: spotlight — dim the feed so ink pops + glow each detected hand
      // (a live "I see your hand" indicator). Armed only, under the drawing.
      if (this.settings.active && this.settings.spotlight) this.drawSpotlight(ctx, canvas);

      // Layer 1: strokes + shapes. Highlight the shape being grabbed, OR — while
      // you're LINING UP a two-finger (victory) select with fingers still open —
      // the shape the aim point is over, so you can see what you'll grab before
      // the sign completes. Aim point = midpoint of the index + middle tips.
      let hlIndex = this.shapeGrab && this.shapeGrab.i >= 0 ? this.shapeGrab.i : -1;
      this.aimPt = null;
      const lm0 = this.hands[0];
      if (hlIndex < 0 && lm0 && lm0.length >= 21) {
        const fe = fingerExtended(lm0);
        if (fe.index && fe.middle) {
          const ax = (lm0[8].x + lm0[12].x) / 2;
          const ay = (lm0[8].y + lm0[12].y) / 2;
          this.aimPt = { x: this.settings.mirror ? 1 - ax : ax, y: ay };
          hlIndex = this.strokes.hitTest(this.aimPt, 0.05); // same tolerance grabShape uses
        }
      }
      this.strokes.render(ctx, canvas.width, canvas.height, hlIndex);
      this.drawSelection(ctx, canvas); // marquee + selected-shape outlines

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
          // No puck — the highlighted shape is the feedback (keeps the grab point
          // from covering what you're selecting).
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

      // Shake-escape feedback: a brief red edge + "cancelled" label.
      const sinceEsc = performance.now() - this.escFlash;
      if (this.escFlash && sinceEsc < 600) {
        ctx.save();
        ctx.globalAlpha = 1 - sinceEsc / 600;
        ctx.lineWidth = Math.max(4, Math.round(canvas.width * 0.008));
        ctx.strokeStyle = "rgba(255,70,70,0.9)";
        ctx.strokeRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "rgba(255,70,70,0.95)";
        ctx.font = `${Math.max(16, Math.round(canvas.width * 0.03))}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText("cancelled", canvas.width / 2, canvas.height * 0.14);
        ctx.restore();
      }

      // Debug HUD: what the model sees + the resolved action (top-left).
      if (this.settings.debug) {
        this.drawFingertips(ctx, canvas);
        this.drawHud(ctx, canvas, hand);
      }

      // Calibration wizard overlay + a brief "calibrated" confirmation.
      this.drawCalibration(ctx, canvas);
      const sinceCal = performance.now() - this.calibDone;
      if (this.calibDone && sinceCal < 1500) {
        ctx.save();
        ctx.globalAlpha = 1 - sinceCal / 1500;
        ctx.fillStyle = "rgba(53,199,89,0.95)";
        ctx.textAlign = "center";
        ctx.font = `${Math.round(canvas.width * 0.028)}px system-ui, sans-serif`;
        ctx.fillText("✓ calibrated", canvas.width / 2, canvas.height * 0.14);
        ctx.restore();
      }

      // Mirror the finished frame into the on-page viewer preview (if shown).
      if (this.settings.preview) updatePreview(this.canvas);

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
        const hr = this.historyRects(this.canvas)[0]; // top (newest) thumbnail
        postStatus({
          running: true,
          armed: !!this.settings.active,
          modelReady: !!recModel.ready,
          modelError: recModel.error || null,
          loadStage: recModel.stage || null,
          hands: recModel.hands || null,
          hand,
          gesture: this.gestureName,
          drawing: !!(this.cursor && this.cursor.mode === "pen"),
          erasing: !!(this.cursor && this.cursor.mode === "erase"),
          transforming: !!(this.cursor && this.cursor.mode === "transform"),
          fps: this.fps,
          strokes: this.strokes.list.length,
          selection: this.selection ? this.selection.length : 0,
          historyMode: !!this.historyMode,
          historyTop: hr ? { x: (hr.x + hr.w / 2) / canvas.width, y: (hr.y + hr.h / 2) / canvas.height } : null,
        });
      }
    };

    // releaseModel=false when we're stopping only to hand off to a fresh
    // augmentor that will immediately reuse the model (avoids a close+reload).
    stop(releaseModel = true) {
      if (this.stopped) return;
      this.stopped = true;
      if (this.raf) cancelAnimationFrame(this.raf);
      active.delete(this);
      for (const t of this.real.getTracks()) t.stop();
      this.video.srcObject = null;
      this.latestResult = null;
      // Nobody's augmenting a camera anymore → tell the isolated world to hand the
      // model's memory back to the OS, and hide the on-page preview panel.
      if (releaseModel && active.size === 0) {
        recFree();
        showPreview(false);
      }
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
      // One augmented camera at a time. A re-request (preview → call, device
      // switch, renegotiation) almost always abandons the previous stream WITHOUT
      // stopping its tracks — so the old augmentor's render loop + model usage
      // would run forever and pile up. Newest wins: stop the older ones now, but
      // keep the model alive since this new augmentor is about to reuse it.
      for (const old of [...active]) old.stop(false);
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
