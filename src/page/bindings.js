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
      // together), ring + pinky curled, not pinching. Uses the injected curl
      // classifier (Fingerpose) when present, else our own finger geometry.
      // Cursor sits at the MIDPOINT of the two fingertips.
      detect: (f) =>
        (f.fpOn ? f.fp === "victory" : f.fingers.index && f.fingers.middle && !f.fingers.ring && !f.fingers.pinky) &&
        !f.penDown &&
        !f.five.on,
      anchor: atTwoFinger,
    },
    {
      name: "fist",
      icon: "👍",
      label: "Fist + thumb out (thumb tip = eraser)",
      priority: 5, // beats pinch, so a fist never reads as draw
      // Fist with the THUMB OUT → erase at the thumb tip (stable pointer). A
      // closed fist (thumb tucked) is a separate gesture below. A double-clench
      // still overrides for one frame (the compound "clear").
      detect: (f) =>
        (f.fpOn ? f.fp === "fist" : !f.fingers.index && !f.fingers.middle && !f.fingers.ring && !f.fingers.pinky) &&
        !f.five.on &&
        f.thumbOut,
      anchor: atThumb,
    },
    {
      name: "closedFist",
      icon: "✊",
      label: "Closed fist (thumb tucked in)",
      priority: 5,
      // All fingers CURLED AND thumb tucked in → pan/move the whole board. No
      // !five.on guard: a closed fist bunches the tips like a five-pinch, but the
      // fingers-curled requirement (vs extended for five-pinch) plus higher
      // priority is what separates them.
      detect: (f) =>
        (f.fpOn ? f.fp === "fist" : !f.fingers.index && !f.fingers.middle && !f.fingers.ring && !f.fingers.pinky) &&
        !f.thumbOut,
      anchor: atPalm,
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
    { name: "grabShape", label: "Move / select shapes" },
    { name: "historyDrag", label: "Drag from history" },
    { name: "grab", label: "Grab · pan · zoom canvas" },
    { name: "transform", label: "Scale · rotate · pan" },
    { name: "clear", label: "Clear all" },
  ];

  // DEFAULT bindings (users override these in the popup → settings.bindings).
  // Victory (two fingers) moves/selects a shape with the cursor between the tips.
  // A thumb-out fist erases; a closed (thumb-tucked) fist pans the board; the
  // two-hand five-finger pinch scales/rotates. Every gesture is rebindable.
  const DEFAULT_BINDINGS = {
    pinch: "draw",
    victory: "grabShape",
    fist: "erase", // thumb-out fist erases at the thumb tip
    closedFist: "grab", // thumb-tucked fist pans/moves the whole board

    fivePinch: "historyDrag", // five-finger pinch drags a board out of the history strip
    twoFivePinch: "transform",
    doubleFist: "clear", // clench your fist twice = wipe the board (fires once)
  };

  const ALL = [...GESTURES, ...TWO_HAND, ...COMPOUND];
  const ACTION_LABEL = Object.fromEntries(ACTIONS_CATALOG.map((a) => [a.name, a.label]));

  // Legend for the CURRENT bindings (defaults to DEFAULT_BINDINGS).
  function legend(bindings) {
    const b = { ...DEFAULT_BINDINGS, ...(bindings || {}) };
    // `bound` is the raw action name ("none" if unassigned) so callers can filter
    // out do-nothing gestures reliably; `action` is the human label.
    return ALL.map((g) => ({ name: g.name, icon: g.icon, how: g.label, bound: b[g.name] || "none", action: ACTION_LABEL[b[g.name]] || "—" }));
  }

  const api = { GESTURES, TWO_HAND, COMPOUND, ALL, ACTIONS_CATALOG, DEFAULT_BINDINGS, legend };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DrawMeBindings = api;
})(typeof window !== "undefined" ? window : null);
