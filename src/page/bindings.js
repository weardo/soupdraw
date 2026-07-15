// draw.me — gesture catalog + bindings (the ONE place to add/edit/rebind gestures).
//
//   engine.js   runs a GENERIC controller over the gesture DEFINITIONS below.
//   bindings.js (this file) defines the gestures (pose predicate + anchor) AND
//               the default gesture→action bindings + the action catalog.
//   pipeline.js implements the ACTIONS and dispatches using the USER's bindings
//               (settings.bindings, editable in the popup — "user-defined controls").
//
// To ADD a gesture: add one object to GESTURES (detect + anchor + icon + label).
// To REBIND: change DEFAULT_BINDINGS, or let the user pick in the popup.
// The legend derives from the live bindings, so it never drifts.
//
// Loadable in the browser (window.DrawMeBindings) and in Node (module.exports).
(function (root) {
  "use strict";

  // anchor helpers: where the cursor sits for a gesture (mirror-aware).
  const atIndex = (f, m) => ({ x: m ? 1 - f.indexTip.x : f.indexTip.x, y: f.indexTip.y });
  const atCluster = (f, m) => ({ x: m ? 1 - f.five.center.x : f.five.center.x, y: f.five.center.y });
  const atPinch = (f, m) => ({ x: m ? 1 - f.pinch.tip.x : f.pinch.tip.x, y: f.pinch.tip.y });
  const atPalm = (f, m) => ({ x: m ? 1 - f.palm.x : f.palm.x, y: f.palm.y }); // fist centre
  const atThumb = (f, m) => ({ x: m ? 1 - f.thumbTip.x : f.thumbTip.x, y: f.thumbTip.y }); // thumb tip
  // midpoint of the index + middle fingertips (the "V" of a Victory sign)
  const atTwoFinger = (f, m) => {
    const x = (f.indexTip.x + f.middleTip.x) / 2;
    const y = (f.indexTip.y + f.middleTip.y) / 2;
    return { x: m ? 1 - x : x, y };
  };

  // SINGLE-HAND gesture definitions (the generic controller consumes detect /
  // anchor / settled / priority / vote / coast). Higher priority wins.
  const GESTURES = [
    {
      name: "pinch",
      icon: "🤏",
      label: "Index pinch (thumb + index)",
      priority: 4, // primary — wins ties
      vote: false, // penDown is already hysteresis+debounced — don't add latency
      coast: true, // survive a brief hand loss mid-stroke
      detect: (f) => f.penDown,
      anchor: atIndex,
      settled: (f) => f.rising < f.RISE_EPS && !f.five.on, // append ink only when not opening
    },
    {
      name: "victory",
      icon: "✌️",
      label: "Victory (index + middle, joined or spread)",
      priority: 3,
      // A "V"/peace sign: index + middle extended (whether spread apart OR held
      // together), ring + pinky curled, not pinching. Reliable to detect and
      // can't fire right after a draw-release (the middle finger is curled then).
      // Cursor sits at the MIDPOINT of the two fingertips.
      detect: (f) =>
        f.fingers.index && f.fingers.middle && !f.fingers.ring && !f.fingers.pinky && !f.penDown && !f.five.on,
      anchor: atTwoFinger,
    },
    {
      name: "fist",
      icon: "✊",
      label: "Fist + thumb out (thumb tip = eraser)",
      priority: 5, // beats pinch, so a fist never reads as draw
      // All four fingers curled and not a five-finger cluster. A double-clench
      // still overrides this for one frame (the compound "clear"). Stick your
      // thumb out and its tip is the eraser point — the thumb doesn't move while
      // you form a fist, so it's a small, stable, predictable pointer.
      detect: (f) => !f.fingers.index && !f.fingers.middle && !f.fingers.ring && !f.fingers.pinky && !f.five.on,
      anchor: atThumb,
    },
    {
      name: "middlePinch",
      icon: "🖕🤏",
      label: "Middle pinch (thumb + middle)",
      priority: 2,
      // VR pinch dictionary: thumb touches the MIDDLE finger (index left free).
      detect: (f) => f.pinch.on && f.pinch.which === "middle" && !f.five.on,
      anchor: atPinch,
    },
    {
      name: "fivePinch",
      icon: "🖐️",
      label: "Five-finger grab",
      priority: 1,
      detect: (f) => f.five.on,
      anchor: atCluster,
      // "settled" = a stable hold (fingers not opening). The grab only commits
      // its transform while settled, so RELEASING the pinch can't perturb the
      // scale/rotation you just set.
      settled: (f) => f.spreadRising < 0.03,
    },
  ];

  // TWO-HAND gestures (detected in the pipeline from both hands).
  const TWO_HAND = [{ name: "twoFivePinch", icon: "🖐️🖐️", label: "Two five-finger pinches" }];

  // COMPOUND (temporal) gestures — a motion over time, detected in the pipeline.
  const COMPOUND = [{ name: "doubleFist", icon: "✊✊", label: "Double fist-clench (close · open · close)" }];

  // What a gesture can be bound to (the action catalog).
  const ACTIONS_CATALOG = [
    { name: "none", label: "— nothing —" },
    { name: "draw", label: "Draw" },
    { name: "erase", label: "Erase" },
    { name: "grabShape", label: "Move one shape" },
    { name: "historyDrag", label: "Drag from history" },
    { name: "grab", label: "Grab · pan · zoom canvas" },
    { name: "transform", label: "Scale · rotate · pan" },
    { name: "clear", label: "Clear all" },
  ];

  // DEFAULT bindings (users override these in the popup → settings.bindings).
  // Victory (two fingers) grabs a single shape with the cursor between the tips.
  // Middle-pinch erases. Single-hand five-finger grab (whole-canvas pan/zoom) is
  // OFF by default — rebind it in the popup anytime. Two-hand transform on.
  const DEFAULT_BINDINGS = {
    pinch: "draw",
    victory: "grabShape",
    fist: "erase", // a held fist erases; middle-pinch freed (rebind either in popup)
    middlePinch: "none",
    fivePinch: "historyDrag", // five-finger pinch drags a board out of the history strip
    twoFivePinch: "transform",
    doubleFist: "clear", // clench your fist twice = wipe the board (fires once)
  };

  const ALL = [...GESTURES, ...TWO_HAND, ...COMPOUND];
  const ACTION_LABEL = Object.fromEntries(ACTIONS_CATALOG.map((a) => [a.name, a.label]));

  // Legend for the CURRENT bindings (defaults to DEFAULT_BINDINGS).
  function legend(bindings) {
    const b = { ...DEFAULT_BINDINGS, ...(bindings || {}) };
    return ALL.map((g) => ({ name: g.name, icon: g.icon, how: g.label, action: ACTION_LABEL[b[g.name]] || "—" }));
  }

  const api = { GESTURES, TWO_HAND, COMPOUND, ALL, ACTIONS_CATALOG, DEFAULT_BINDINGS, legend };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DrawMeBindings = api;
})(typeof window !== "undefined" ? window : null);
