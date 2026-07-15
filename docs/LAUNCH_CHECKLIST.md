# draw.me — Firefox launch checklist

Target: publish on addons.mozilla.org (AMO), or self-distribute a signed `.xpi`.
Status legend: [ ] todo · [~] partial · [x] done

---

## A. Packaging & store requirements (AMO)

### Legal / attribution (blocking)
- [ ] **Project LICENSE file** at repo root (package.json says ISC — add the file, or pick MIT/Apache-2.0).
- [ ] **MediaPipe Apache-2.0 attribution** — `vendor/tasks-vision/` ships minified Apache-2.0 code but has **no LICENSE/NOTICE**. Add `LICENSE` (Apache-2.0 text) + a `NOTICE` crediting `@mediapipe/tasks-vision`.
- [x] Fingerpose MIT LICENSE present (`vendor/fingerpose/LICENSE`).
- [ ] **Privacy policy** for the listing. Ours is a selling point: on-device only, no network, nothing leaves the machine. `data_collection_permissions: none` is already declared in the manifest.

### Reviewer-facing (blocking — this add-on WILL get manual review)
- [x] **Reviewer notes** — written in `docs/SUBMISSION.md` (getUserMedia patch + wasm-unsafe-eval + no-network rationale). Paste into the "Notes to reviewer" field.
- [x] **Source-code / build instructions** — in `docs/SUBMISSION.md` (vendor files = unmodified npm `@mediapipe/tasks-vision` + fingerpose; no build step). Upload the repo as source.
- [x] **Privacy policy** — `PRIVACY.md` (on-device, no data collection). Contact: support@soupup.ai.
- [x] **Listing copy** (summary + description + categories) — in `docs/SUBMISSION.md`.
- [x] **Screenshots** — `docs/screenshots/{01-two-hand-transform,02-pan-and-draw,03-guided-practice}.png` (2796×1648, browser chrome cropped out).
- [x] **Package built** — `web-ext-artifacts/soupdraw_gesture_camera_drawing-1.0.0.zip`.

### Manifest / assets (blocking)
- [ ] **Reconcile version** — manifest `0.1.0` vs package.json `1.0.0`. Pick one (recommend `0.9.0` beta or `1.0.0`).
- [ ] Add `author` and `homepage_url` to manifest.
- [ ] Add a **128px icon** (AMO listing thumbnail); have 48 + 96.
- [ ] `web-ext build` to produce the upload `.zip`. (Lint already passes: 0 errors.)

### Size (should-do)
- [ ] **~41MB, mostly 3 WASM variants** (`vision_wasm_internal` + `_module_` + `_nosimd_`, ~11MB each = 33MB). Investigate dropping the unused variants (likely keep SIMD + nosimd fallback, drop `module`). Test load still works before removing — could cut ~11–22MB and speed review + install.

---

## B. Pre-publish product work

### Blocking correctness
- [ ] **Default `debug: false`.** The debug HUD renders on the OUTPUT canvas → viewers see it. Flip the default in `src/content/bridge.js`, `src/popup/popup.js`, and pipeline state.
- [ ] **Background-tab throttling.** When the drawing tab is backgrounded, Firefox throttles rAF to ~1fps → viewers get a choppy feed (core "draw in tab A, call in tab B" flow). Either fix (a `requestVideoFrameCallback`-driven render clock that survives backgrounding) or clearly document "keep the tab visible."

### Keyboard shortcuts (raised)
- [x] `Alt+Shift+D` = arm/disarm, via the `commands` API (conflict-free, remappable in about:addons) — wired in `src/background.js`.
- [x] **Undo `Alt+Shift+Z` / Redo `Alt+Shift+Y`** added (reuse the popup's nonce plumbing → work hands-free mid-draw). Surfaced as popup tooltips + an onboarding "Keyboard shortcuts" card. (Deliberately no default hotkey for destructive Clear.)

### Onboarding / training flow (raised)
- [x] **First-run experience.** `src/onboard/onboard.html` opens on install (`runtime.onInstalled`): brand hero, 3-step quick start, call-safe explainer, shortcuts.
- [x] **Gesture cheat-sheet** — rendered live from `DrawMeBindings.legend(userBindings)` (single source of truth; reflects the user's own rebindings; never drifts).
- [x] **Interactive training flow** — `src/train/` (train.html/css/js + hands.js). A dedicated, persistent window: live camera + hand-skeleton overlay + an ANIMATED ghost-hand guide (VR-style, interpolated poses) that demonstrates each gesture; live detection via the SAME engine + recognizer iframe advances each step on a held match. **Calibration is step 1** (in-window; saves pinchDown/pinchUp to storage for the call pipeline). Launched from the popup ("▶ Practice gestures & calibrate") and the onboarding CTA. This replaces the in-call canvas calibration overlay (fixes "preview closes after calibration": calibration + preview + guidance now live in one window that never auto-closes).

---

## C. Deferred / optional (post-v1)

- [ ] Meet self-tile injection (dock our feed over Meet's mirrored self-view; Meet-specific + fragile).
- [ ] Sign-language Phase 1 (Fingerpose fingerspelling recognizer + live letter readout).
- [ ] Wire the $Q recognizer (arrow/check/X/digits — built, not wired into the pipeline).
- [ ] Vosk local voice ("say a phrase → shape appears").
- [ ] Extend the calibration wizard to more thresholds (five-pinch spread, thumb-out).
- [ ] Handedness-based bindings (left=erase / right=draw, etc. — foundation exists).

---

## Done this session
- [x] `debug: false` default (was rendering the HUD onto the viewer feed).
- [x] Project `LICENSE` (MIT) + MediaPipe `vendor/tasks-vision/{LICENSE,NOTICE}` (Apache-2.0).
- [x] Version reconciled to `1.0.0`; `author` added; **128px icon** generated + registered.
- [x] **Settings panel reorganized (SLIPPERY):** master + Arm (with `Alt+Shift+D` chip) on top → one-tap Undo/Redo/Clear → pen color/size + Viewer preview → *Setup & appearance* and *Gesture controls* collapsed into `<details>`. Em-dash UI copy removed.

## Open decisions / queued
- [x] **Name: SoupDraw** (brand-derived from Soup Up → inherently ownable; search-clean; AirDraw/Scribbl/Handmark all rejected as taken/crowded). Applied to manifest `name`/`homepage_url` (`soupdraw.soupup.ai`)/`author` ("Soup Up")/gecko id (`soupdraw@soupup.ai`), popup logo+title, package.json, README. Internal code ids (`__drawme`) intentionally unchanged.
- **README content refresh** — the body still describes an old "Phase 1" gesture set + a wrong "MAIN-world bypasses CSP" claim + `hand_landmarker.task` (we use `gesture_recognizer.task`). Refresh before publishing.
- **Client-side web app (`soupdraw.soupup.ai`)** — proposed by user: a standalone in-browser scribble site reusing the same engine (see note below). Strong PLG funnel; scope as its own increment.
- **Undo/redo accessibility (queued by user):** buttons exist in the popup; user wants it built out — likely a gesture and/or a keyboard command (`commands` API) so it's reachable mid-draw without opening the popup.

## Suggested order

1. `debug:false` default (viewers-see-HUD bug) — 5 min, must-do.
2. Licenses (project + MediaPipe NOTICE) + version reconcile + manifest author/homepage + 128 icon — quick, unblocks submission.
3. Onboarding: cheat-sheet page first, then the interactive training flow.
4. Keyboard shortcut audit/expansion.
5. Background-tab decision (fix vs document).
6. WASM-variant trim (test-gated).
7. Privacy policy + reviewer notes + source instructions.
8. `web-ext build` → submit.
