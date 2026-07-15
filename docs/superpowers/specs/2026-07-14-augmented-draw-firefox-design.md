# draw.me — Augmented Gesture Drawing on Live Camera (Firefox Extension)

Date: 2026-07-14
Status: Phase 1 (pipeline) in progress

## Vision

A Firefox extension that lets you draw and manipulate objects on your **live
camera feed using hand gestures**, so that the augmented video is what other
people see inside any video-call app (Google Meet, Zoom web, etc.). All
processing is **on-device — no network at runtime**.

## Hard constraints

- **On-device only.** No audio/video/frames leave the machine. All ML assets
  (MediaPipe wasm + model, and later Vosk) are bundled in the extension and
  loaded from `moz-extension://` URLs. No CDN, no cloud speech.
- **Generic delivery.** We do not target one call app's DOM. We patch
  `navigator.mediaDevices.getUserMedia` globally; any site that requests the
  camera receives our augmented canvas stream instead.
- **Laptop-grade performance.** Must run acceptably alongside a live call.

## Architecture

```
call page (Meet/Zoom/…)  ── requests camera ──►  patched getUserMedia
                                                      │
                                                      ▼
                                   real getUserMedia → hidden <video> (true cam)
                                                      │  every frame
                                                      ▼
              MediaPipe HandLandmarker (WASM, local) → landmarks
                                                      │
                                          gesture logic (pinch = pen down)
                                                      │
                       ┌──────────── compositor <canvas> ────────────┐
                       │  layer 0: mirrored camera video             │
                       │  layer 1: drawing (strokes / objects)       │
                       └──────────────────────────────────────────────┘
                                                      │
                                       canvas.captureStream(30)
                                                      │
                                    returned to the call page as "the camera"
```

### Components (isolation boundaries)

1. **`manifest.json`** — Firefox MV3. Registers the content bridge on all
   frames, the popup, and exposes vendor assets + page script as
   `web_accessible_resources`.

2. **Content bridge — `src/content/bridge.js`** (isolated world). Its only jobs:
   inject the page-world module, pass it the extension base URL (so the page
   script can build `moz-extension://` asset URLs), and relay the on/off +
   settings state between the popup and the page world via `window.postMessage`
   + `browser.storage`. Contains no drawing logic.

3. **Page pipeline — `src/page/pipeline.js`** (MAIN world, ES module). The core.
   - Patches `getUserMedia` (and `mediaDevices.getUserMedia`) once.
   - When enabled + video requested: gets the real stream, builds the
     compositor, runs `HandLandmarker`, applies gesture logic, returns
     `canvas.captureStream()`.
   - When disabled: passes the real stream straight through.

4. **Gesture + drawing engine — `src/page/engine.js`** (pure logic, own file).
   `PinchPen` converts landmarks → pen events: pinch (thumb-tip↔index-tip
   distance, hand-size-normalized, with hysteresis) toggles pen down/up;
   fingertip position is the cursor (mirror-aware). `Strokes` is the drawing
   model: an ordered list of strokes (points + color + width) with EMA
   smoothing. This file has **no browser APIs**, so it is unit-tested in Node
   (`test/engine.test.mjs`). Loaded as a MAIN-world content script before
   pipeline.js; also `require`-able in Node.

5. *(merged into 4 — the drawing model `Strokes` lives in `engine.js`.)*

6. **Popup — `src/popup/`.** Toggle on/off, mirror toggle, color/size, "clear",
   and a live status line (tracking / FPS / hand-detected).

7. **Test harness — `test/local.html`.** A standalone page that calls
   `getUserMedia` and shows the returned stream, so the whole pipeline can be
   exercised without joining a real call.

## Data flow / messaging

- Popup ↔ page: popup writes settings to `browser.storage.local`; bridge reads
  and forwards to the page world via `postMessage({source:'draw.me', ...})`.
  Bridge also listens to `storage.onChanged` for live updates.
- Page → popup status: page posts status back through the bridge, which stores
  a lightweight status object the popup polls while open.

## Gesture logic (Phase 1)

- Normalize landmarks (0..1) to canvas pixels; account for mirroring.
- Pinch = distance(thumb_tip, index_tip) < threshold (hysteresis: separate
  down/up thresholds to avoid flicker).
- On pen-down: start a new stroke. While down: append smoothed points
  (EMA on position) to reduce jitter. On pen-up: end the stroke.
- One-euro / EMA smoothing so lines aren't shaky.

## Error handling

- If HandLandmarker fails to load, pipeline logs once and falls back to
  pass-through (real camera, no crash) — the call must never break.
- getUserMedia patch wraps the original in try/catch; any failure falls back to
  the original implementation.
- Guard against double-patching (idempotent install).

## Performance plan

- Run inference in VIDEO mode with `detectForVideo(video, ts)` at the display
  rAF rate; cap the model to `numHands: 1` for Phase 1.
- Composite on a single canvas sized to the source track resolution.
- If frame budget is exceeded, we can later throttle inference to every Nth
  frame while compositing every frame.

## Phasing

- **Phase 1 (this spec):** getUserMedia patch + hand tracking + pinch freehand
  draw + clear, working end-to-end. Popup on/off + color/size. Test harness.
- Phase 2: move/drag objects. Phase 3: erase gesture + shapes/stamps.
- Phase 4: local Vosk voice → "say a phrase, shape appears".

## Non-goals (now)

- No per-app DOM tuning. No recording/streaming. No cloud anything.
