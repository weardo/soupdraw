# SoupDraw — AMO submission pack

Everything to paste into the addons.mozilla.org developer forms.

---

## Listing summary (max ~250 chars)

Draw and annotate on your live camera with hand gestures, inside any video call
(Meet, Zoom web, Teams, Whereby). Pinch to draw, erase, move, scale, rotate. 100%
on-device — no video, frames, or data ever leave your machine.

## Listing description

SoupDraw turns your webcam into a gesture-driven whiteboard for video calls. Turn
it on, join any call, pick your camera, and the other participants see your
augmented feed.

Gestures (all rebindable, with a built-in interactive Practice tutorial):
- 🤏 Pinch (thumb + index) to draw
- ✌️ Victory to move a shape, or box-select
- 👍 Thumb-out fist to erase (the thumb tip is the eraser)
- ✊ Closed fist to pan the whole board
- 🖐️🖐️ Two-hand five-finger pinch to scale / rotate / pan (selection or canvas)
- 🖐️ Five-finger pinch to restore a board from history

Everything runs on-device using a bundled MediaPipe hand model. Nothing — no
video, no frames, no data — ever leaves your machine. There are no network calls
at runtime, no accounts, and no tracking.

Keyboard: Alt+Shift+D (Cmd+Shift+D on Mac) arms/disarms; Alt+Shift+Z / Y undo/redo.

A tool by Soup Up · https://soupup.ai

## Categories

Photos & Media / Appearance (or Other). Tags: camera, video call, gesture,
drawing, annotate, whiteboard, webcam.

## Privacy policy

Use the contents of PRIVACY.md (host it, or paste it into the privacy-policy field).

---

## Notes for reviewers (paste into "Notes to reviewer")

What it does: SoupDraw lets a user draw on their OWN camera feed with hand gestures
so their video-call app receives the augmented picture. It is a local compositor.

Why the permissions look the way they do:
- It injects a MAIN-world content script on <all_urls> that wraps
  `navigator.mediaDevices.getUserMedia`. When the page requests the camera, we
  take that real stream, draw it plus the user's strokes onto a <canvas>, and
  return `canvas.captureStream()` in its place. This is the only way to inject
  drawings into an arbitrary call app's camera. If anything fails, it returns the
  real, untouched camera (the call never breaks).
- `<all_urls>` is required because the user may take a call on any site.
- `wasm-unsafe-eval` (in content_security_policy.extension_pages) is required by
  the bundled MediaPipe WASM hand-tracking model, which runs in an
  extension-origin iframe (src/offscreen/recognizer.html) — NOT in the page.

Data handling: There are NO network requests at runtime. No video/frames/data are
transmitted, stored remotely, or shared. The model is bundled locally. Only
settings + the current drawing are saved to storage.local. See PRIVACY.md.

How to test: open the toolbar popup → "Practice gestures & calibrate" for a guided
camera tutorial, or use the local harness (README "Try it without a call").

## Source code (required — bundled minified third-party code)

Upload this repository as the source. There is no build/transpile step — the
extension IS the source. The only minified files are unmodified third-party
libraries:

- `vendor/tasks-vision/*` — unmodified distribution files of the npm package
  `@mediapipe/tasks-vision` (Apache-2.0). To reproduce: `npm i @mediapipe/tasks-vision`
  at the version in package.json and copy `vision_bundle.mjs`,
  `vision_wasm_internal.{js,wasm}`, `vision_wasm_module_internal.{js,wasm}`,
  `vision_wasm_nosimd_internal.{js,wasm}`, `gesture_recognizer.task` from
  `node_modules/@mediapipe/tasks-vision/`. See vendor/tasks-vision/NOTICE.
- `vendor/fingerpose/fingerpose.js` — Fingerpose (MIT). See vendor/fingerpose/LICENSE.

All first-party code (src/, tests) is plain, unminified JavaScript. Run
`node --test test/*.mjs` for the unit tests and `web-ext lint` for validation.
