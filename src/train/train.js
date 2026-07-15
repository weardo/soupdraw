// SoupDraw — practice COACH. The page loads the real pipeline (bindings + engine +
// pipeline.js), so calling getUserMedia here returns the actual augmented feed: your
// real camera + real drawings + real gestures/actions/history. This file adds ONLY
// the coaching overlay — a ghost hand showing each gesture — and advances steps by
// reading the pipeline's live status. Nothing is simulated; you use the real tool.
(() => {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const H = window.SoupHands;

  const cam = document.getElementById("cam");
  const overlay = document.getElementById("overlay");
  const octx = overlay.getContext("2d");
  const startCard = document.getElementById("startCard");
  const doneCard = document.getElementById("doneCard");
  const startBtn = document.getElementById("startBtn");
  const doneBtn = document.getElementById("doneBtn");
  const skipBtn = document.getElementById("skipBtn");
  const promptEl = document.getElementById("prompt");
  const promptIcon = document.getElementById("promptIcon");
  const promptTitle = document.getElementById("promptTitle");
  const promptText = document.getElementById("promptText");
  const progressEl = document.getElementById("progress");

  const tri = (t) => (t < 0.5 ? t / 0.5 : 1 - (t - 0.5) / 0.5);
  const PATHS = {
    circle: (t) => ({ x: 0.5 + 0.13 * Math.cos(t * Math.PI * 2), y: 0.44 + 0.19 * Math.sin(t * Math.PI * 2) }),
    swipe: (t) => ({ x: 0.36 + 0.28 * tri(t), y: 0.5 }),
    drag: (t) => ({ x: 0.42 + 0.22 * tri(t), y: 0.46 }),
    // history: grab the REAL strip thumbnail (histTop, top-right), drag to the board.
    historyPull: (t) => {
      const start = histTop;
      const end = { x: 0.45, y: 0.5 };
      if (t < 0.15) return start;
      if (t > 0.85) return end;
      const k = (t - 0.15) / 0.7;
      return { x: start.x + (end.x - start.x) * k, y: start.y + (end.y - start.y) * k };
    },
    box: (t) => {
      const p = t * 4;
      if (p < 1) return { x: 0.35 + 0.3 * p, y: 0.34 };
      if (p < 2) return { x: 0.65, y: 0.34 + 0.26 * (p - 1) };
      if (p < 3) return { x: 0.65 - 0.3 * (p - 2), y: 0.6 };
      return { x: 0.35, y: 0.6 - 0.26 * (p - 3) };
    },
  };

  // Steps = the real gestures, detected from the pipeline's live status so you
  // actually perform each action. `detect(status, baseline)` → step complete.
  const STEPS = [
    { type: "calibrate", icon: "🎯", title: "Calibrate your pinch", text: "Follow the on-screen prompts: pinch and hold, then open your hand wide." },
    { gesture: "pinch", pose: "pinch", path: "circle", icon: "🤏", title: "Pinch to draw", text: "Touch thumb + index and move to draw. Draw any shape.", detect: (s, b) => s.strokes > b.strokes },
    { gesture: "fist", pose: "fist", path: "swipe", icon: "👍", title: "Erase", seed: "scribble", text: "Thumb-out fist. Swipe the thumb tip over the scribble to rub it out.", detect: (s, b) => s.erasing || s.strokes < b.strokes },
    { gesture: "victory", pose: "victory", path: "drag", icon: "✌️", title: "Move a shape", seed: "shapes", text: "Make a V over a shape, then move your hand to drag it.", detect: (s) => s.gesture === "victory" },
    { gesture: "victory", pose: "victory", path: "box", icon: "✌️", title: "Select shapes", seed: "shapes", text: "Make a V on EMPTY space and drag a box around the shapes to select them.", detect: (s) => s.selection > 0 },
    { gesture: "twoFivePinch", pose: "five", twoHand: true, icon: "🖐️🖐️", title: "Scale / rotate / pan your SELECTION", seed: "select", text: "The shapes are already selected. Pinch all five on both hands and move them — only the selection transforms.", detect: (s) => s.transforming && s.selection > 0 },
    { gesture: "closedFist", pose: "closedFist", path: "drag", icon: "✊", title: "Pan the canvas", seed: "shapes", text: "Closed fist, thumb tucked in, then move to slide the whole board.", detect: (s) => s.gesture === "closedFist" },
    { gesture: "twoFivePinch", pose: "five", twoHand: true, icon: "🖐️🖐️", title: "Scale / rotate / pan the CANVAS", seed: "shapes", text: "With nothing selected, two-hand pinch transforms the whole board.", detect: (s) => s.transforming && !s.selection },
    { gesture: "openHistory", pose: "five", pulse: true, icon: "🖐️", title: "Open the history strip", seed: "history", text: "Pinch all five fingertips together TWICE, quickly, to open the history strip (top-right).", detect: (s) => s.historyMode },
    { gesture: "fivePinch", pose: "five", path: "historyPull", icon: "🖐️", title: "Restore a board", keepHistory: true, text: "Five-finger pinch the thumbnail on the strip, then drag it onto the board.", detect: (s, b) => s.strokes > b.strokes },
    { gesture: "doubleFist", pose: "closedFist", icon: "✊✊", title: "Clear the board", seed: "shapes", text: "Clench your fist twice (close, open, close) to wipe everything.", detect: (s, b) => s.strokes === 0 && b.strokes > 0 },
  ];

  // Config handed to the hosted pipeline (training-friendly: no HUD, no preview).
  const CFG = {
    enabled: true, active: true, mirror: true, boost: true, assist: true, debug: false,
    minimap: false, history: true, spotlight: true, preview: false, hideCamera: false,
    boardColor: "#14151a", color: "#ff2d55", size: 6,
    clearNonce: 0, undoNonce: 0, redoNonce: 0, calibNonce: 0, pinchDown: null, pinchUp: null,
    bindings: { ...window.DrawMeBindings.DEFAULT_BINDINGS },
  };
  const postCfg = () => window.postMessage({ __drawme: "config", base: api.runtime.getURL(""), settings: CFG }, "*");

  let running = false, raf = 0, stepIdx = 0, advancing = false, okFlash = 0, hits = 0;
  let latest = { strokes: 0 }, base = { strokes: 0, selection: 0 };
  let baseFrozen = false, enterAt = 0;
  let histTop = { x: 0.92, y: 0.12 }; // real strip position (from status.historyTop)

  // pull any saved calibration into the config, then announce it
  api.storage.local
    .get("settings")
    .then(({ settings }) => {
      if (settings) {
        if (typeof settings.pinchDown === "number") CFG.pinchDown = settings.pinchDown;
        if (typeof settings.pinchUp === "number") CFG.pinchUp = settings.pinchUp;
      }
      postCfg();
    })
    .catch(postCfg);

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m.__drawme !== "string") return;
    if (m.__drawme === "ready") postCfg();
    else if (m.__drawme === "status" && m.status) onStatus(m.status);
    else if (m.__drawme === "calibrated") {
      if (m.thresholds) {
        CFG.pinchDown = m.thresholds.pinchDown;
        CFG.pinchUp = m.thresholds.pinchUp;
        api.storage.local.get("settings").then(({ settings }) => api.storage.local.set({ settings: { ...(settings || {}), ...m.thresholds } })).catch(() => {});
      }
      if (STEPS[stepIdx] && STEPS[stepIdx].type === "calibrate") pass();
    }
  });

  function onStatus(s) {
    latest = s;
    if (s.historyTop) histTop = s.historyTop; // learn where the real strip is
    if (!running || advancing) return;
    const step = STEPS[stepIdx];
    if (!step || step.type === "calibrate") return; // calibrate advances on 'calibrated'
    if (step.keepHistory) window.postMessage({ __drawme: "train", cmd: "historyopen" }, "*"); // hold the strip open
    // Hold the baseline open for ~500ms after entering so it reflects the seeded
    // board (the seed is applied before detection can fire).
    if (!baseFrozen) {
      base = { strokes: s.strokes || 0, selection: s.selection || 0 };
      if (performance.now() - enterAt > 500) baseFrozen = true;
      return;
    }
    const on = s.gesture === step.gesture || (step.twoHand && s.transforming) || (step.detect && step.detect(s, base));
    setPrompt(step.icon, on ? "That's it — keep going…" : step.title, step.text, !!on);
    if (step.detect(s, base)) {
      if (++hits >= 1) pass();
    } else hits = 0;
  }

  // ---- overlay (ghost only; detection is status-driven) ---------------------
  function fit() {
    const w = overlay.clientWidth | 0, h = overlay.clientHeight | 0;
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  }
  // The video uses object-fit:contain, so map ghost coords into the video's actual
  // (letterboxed) content rect — otherwise the ghost drifts off the real frame
  // (and off the history strip).
  function videoRect() {
    const vw = cam.videoWidth || 4, vh = cam.videoHeight || 3;
    const s = Math.min(overlay.width / vw, overlay.height / vh);
    const w = vw * s, h = vh * s;
    return { x: (overlay.width - w) / 2, y: (overlay.height - h) / 2, w, h };
  }
  function drawOneGhost(pose, cx, cy, scale) {
    const r = videoRect();
    const lm = H.buildHand(pose);
    const w = Math.min(r.w * (scale || 0.22), 210);
    const box = { x: r.x + cx * r.w - w / 2, y: r.y + cy * r.h - w * 0.5, w, h: w * 1.15 };
    H.drawHand(octx, lm, box, { stroke: "rgba(255,255,255,0.9)", glow: "rgba(255,255,255,0.3)", joint: "#fff", tip: "#ff2d55", mirror: false, width: 5, dot: 4, blur: 6 });
  }
  // Dotted route the hand travels — makes "drag from HERE to THERE" obvious.
  function drawPathTrail(step) {
    if (!step.path || !PATHS[step.path]) return;
    const r = videoRect();
    octx.save();
    octx.strokeStyle = "rgba(120,220,255,0.55)";
    octx.setLineDash([7, 7]);
    octx.lineWidth = 2.5;
    octx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const p = PATHS[step.path](i / 48);
      const x = r.x + p.x * r.w, y = r.y + p.y * r.h;
      i ? octx.lineTo(x, y) : octx.moveTo(x, y);
    }
    octx.stroke();
    octx.setLineDash([]);
    octx.restore();
  }
  function drawGhost(step, ts) {
    if (step.pulse) {
      // "pinch all five twice" — open ↔ gathered, twice per loop (a double tap).
      const k = Math.abs(Math.sin((ts % 1300) / 1300 * Math.PI * 2));
      drawOneGhost(H.mixPose(H.POSES.open, H.POSES.five, k), 0.5, 0.44, 0.2);
      return;
    }
    if (step.twoHand) {
      const t = (ts % 3400) / 3400;
      const spread = 0.11 + 0.05 * Math.sin(t * Math.PI * 2);
      const ang = 0.3 * Math.sin(t * Math.PI * 2);
      const ox = Math.cos(ang) * spread, oy = Math.sin(ang) * spread;
      drawOneGhost(H.POSES.five, 0.5 - ox, 0.45 - oy, 0.16);
      drawOneGhost(H.POSES.five, 0.5 + ox, 0.45 + oy, 0.16);
      return;
    }
    drawPathTrail(step);
    let cx = 0.5, cy = 0.42;
    if (step.path && PATHS[step.path]) {
      const p = PATHS[step.path]((ts % 3400) / 3400);
      cx = p.x;
      cy = p.y;
    }
    drawOneGhost(H.POSES[step.pose] || H.POSES.open, cx, cy, 0.2);
  }
  function drawFlash() {
    const since = performance.now() - okFlash;
    if (!okFlash || since > 700) return;
    octx.save();
    octx.globalAlpha = 1 - since / 700;
    octx.fillStyle = "#35c759";
    octx.font = "800 84px system-ui, sans-serif";
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    octx.fillText("✓", overlay.width / 2, overlay.height / 2);
    octx.restore();
  }
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    fit();
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (running && !advancing) {
      const step = STEPS[stepIdx];
      if (step && step.type !== "calibrate") drawGhost(step, ts);
    }
    drawFlash();
  }

  // ---- flow -----------------------------------------------------------------
  function buildProgress() {
    progressEl.replaceChildren();
    STEPS.forEach(() => progressEl.appendChild(Object.assign(document.createElement("span"), { className: "pip" })));
    updateProgress();
  }
  function updateProgress() {
    [...progressEl.children].forEach((el, i) => (el.className = "pip" + (i < stepIdx ? " done" : i === stepIdx ? " active" : "")));
  }
  function setPrompt(icon, title, text, ok) {
    promptIcon.textContent = icon;
    promptTitle.textContent = title;
    promptTitle.className = ok ? "ok" : "";
    promptText.textContent = text || "";
  }
  function enterStep() {
    hits = 0;
    baseFrozen = false;
    enterAt = performance.now();
    base = { strokes: 0, selection: 0 };
    updateProgress();
    const step = STEPS[stepIdx];
    if (!step) return;
    setPrompt(step.icon, step.title, step.text);
    if (step.type === "calibrate") {
      // trigger the REAL pipeline calibration (draws on the augmented feed).
      CFG.calibNonce = (CFG.calibNonce || 0) + 1;
      postCfg();
    } else if (step.seed) {
      // seed real board content so the step has something to act on
      window.postMessage({ __drawme: "train", cmd: step.seed }, "*");
    } else if (step.keepHistory) {
      // restore step: make sure the strip is open from the get-go
      window.postMessage({ __drawme: "train", cmd: "historyopen" }, "*");
    }
  }
  function pass() {
    if (advancing) return;
    advancing = true;
    okFlash = performance.now();
    setPrompt("✓", "Nice!", "", true);
    setTimeout(() => {
      advancing = false;
      stepIdx++;
      if (stepIdx >= STEPS.length) finish();
      else enterStep();
    }, 900);
  }
  async function start() {
    let stream;
    try {
      // the hosted pipeline has patched getUserMedia → this returns the augmented feed
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 720 }, audio: false });
    } catch (e) {
      startCard.querySelector("p").textContent = "Camera permission is needed to practice. Allow it and click Start again.";
      return;
    }
    cam.srcObject = stream;
    await cam.play().catch(() => {});
    startCard.hidden = true;
    promptEl.hidden = false;
    running = true;
    stepIdx = 0;
    enterStep();
    raf = raf || requestAnimationFrame(loop);
  }
  function finish() {
    running = false;
    promptEl.hidden = true;
    doneCard.hidden = false;
    localizeShortcuts();
    if (cam.srcObject) cam.srcObject.getTracks().forEach((t) => t.stop());
  }
  async function localizeShortcuts() {
    try {
      const cmds = await api.commands.getAll();
      const map = {};
      for (const c of cmds) map[c.name] = (c.shortcut || "").replace(/Command/g, "Cmd").replace(/MacCtrl/g, "Ctrl");
      document.querySelectorAll(".kbd[data-cmd]").forEach((el) => {
        const s = map[el.dataset.cmd];
        if (s) el.textContent = s;
      });
    } catch (_) {}
  }

  startBtn.addEventListener("click", start);
  skipBtn.addEventListener("click", () => running && !advancing && pass());
  // Finished → restart the run (don't close the window).
  doneBtn.addEventListener("click", () => {
    doneCard.hidden = true;
    start();
  });
  buildProgress();
  raf = requestAnimationFrame(loop);
})();
