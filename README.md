# SoupDraw: gesture camera drawing

*Draw on your live camera feed with hand gestures, on-device. A [Soup Up](https://soupup.ai) tool.*

A Firefox extension that lets you **draw on your live camera feed with hand
gestures**, so the augmented video is what other people see inside any video-call
app (Google Meet, Zoom web, Teams, Whereby, …). It works by transparently
replacing the camera any site receives with a canvas we composite locally.

**Everything runs on-device. Nothing — no video, no frames, no audio — leaves
your machine.** The hand-tracking model is bundled in the extension; there are
no network calls at runtime.

## Gestures (defaults)

| Gesture | Does |
| --- | --- |
| 🤏 Index pinch (thumb + index) | Draw |
| ✌️ Victory (index + middle, joined or spread) | Move / select shapes (cursor sits between the fingertips) |
| ✊ Fist, thumb out | Erase at the thumb tip |
| ✊ Closed fist (thumb tucked in) | Grab · pan · zoom the whole board |
| 🖐️ Five-finger grab | Drag a board out of the history strip |
| 🖐️🖐️ Two five-finger pinches | Scale · rotate · pan the canvas |
| ✊✊ Double fist-clench (close · open · close) | Clear the board |

Every gesture is rebindable from the popup, under **Gesture controls**. **Shape
assist** optionally snaps a rough circle / line / box / triangle to a clean shape
when it clearly fits one (freehand and squiggles are left alone), including
multi-stroke figures.

## Keyboard shortcuts

| Shortcut (Win/Linux · Mac) | Does |
| --- | --- |
| `Alt+Shift+D` · `Cmd+Shift+D` | Arm / disarm drawing |
| `Alt+Shift+Z` · `Cmd+Shift+Z` | Undo |
| `Alt+Shift+Y` · `Cmd+Shift+Y` | Redo |

Customize them in `about:addons` → Manage Extension Shortcuts. (No default
shortcut for Clear, to avoid wiping the board by accident.)

## Install (temporary, for development)

1. Open Firefox → `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` in this folder.

The SoupDraw icon appears in the toolbar. (Temporary add-ons unload when Firefox
restarts — reload the same way to bring it back.)

## Try it without a call (test harness)

1. Serve this folder so the test page has a real origin:
   ```
   npm run serve        # python3 -m http.server 8123
   ```
2. Open `http://localhost:8123/test/local.html`.
3. Click the SoupDraw toolbar icon → turn **Augment my camera** ON. Pick a color.
4. On the test page, click **Start camera** and allow the camera prompt.
5. Hold your hand up. **Pinch thumb + index** to draw; move to steer; release to
   lift. Use **Clear drawing** in the popup to reset.

The video you see is the exact stream a call app would receive.

## Use it in a real call

1. Turn **Augment my camera** ON in the popup **before** joining/enabling your
   camera in the call app.
2. Join the call and pick your normal camera. The app receives the augmented
   feed; other participants see your drawings.
3. Toggling the extension on/off takes effect the next time the app requests the
   camera (turn the call's camera off and on again, or rejoin).

## How it works

```
call page ── getUserMedia ──► patched getUserMedia (MAIN world)
                                   │  real camera → hidden <video>
                                   ▼
        MediaPipe HandLandmarker (bundled WASM) → landmarks
                                   │  pinch = pen down (engine.js)
                                   ▼
        compositor <canvas>: mirrored camera + your strokes
                                   │  captureStream(30)
                                   ▼
                 returned to the call page "as the camera"
```

- `src/content/bridge.js` — isolated content script; the only code that touches
  `browser.storage`. Relays settings/config to the page world.
- `src/page/engine.js` — pure gesture + drawing logic (pinch detection, stroke
  model). No browser APIs; unit-tested in Node.
- `src/page/pipeline.js` — MAIN-world script: patches `getUserMedia`, runs the
  compositor loop, loads the bundled model.
- `src/popup/` — the control panel.
- `vendor/tasks-vision/` — bundled MediaPipe wasm + `hand_landmarker.task`.

See `docs/superpowers/specs/2026-07-14-augmented-draw-firefox-design.md` for the
full design.

## Known Phase 1 limitations

- Toggling on/off mid-call requires the app to re-request the camera (see above).
- Very strict-CSP sites are the reason we use a MAIN-world content script (not
  blocked by page CSP); if a site still refuses, the extension safely falls back
  to passing your real camera through — the call never breaks.
- One hand, freehand strokes only (drag/erase/shapes/voice are later phases).
- First camera start pays a one-time model-load cost (~8 MB from local disk).

## Development

```
npm test     # run the gesture/stroke engine unit tests
npm run lint # web-ext lint
npm run serve # serve the test harness on :8123
```

## Privacy

No telemetry, no network, no accounts. The camera never leaves the page it was
requested on; we only re-composite it locally before handing it back.
