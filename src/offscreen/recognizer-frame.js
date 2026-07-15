// draw.me — recognizer FRAME (runs inside an extension-origin IFRAME document)
//
// WHY AN IFRAME: MediaPipe can't load in the MAIN world (page CSP blocks its
// wasm/import), in the content-script sandbox (its <script>-tag glue loader runs
// in the page world → "ModuleFactory not set"), OR via a Worker spawned from the
// content script (the page's `require-trusted-types-for 'script'` blocks the
// Worker constructor sink). An iframe pointed at a web_accessible_resource is a
// REAL document with the EXTENSION's origin + CSP — which grants 'wasm-unsafe-eval'
// and has no trusted-types requirement — so tasks-vision's <script>-tag glue
// loader works exactly as on an ordinary page. src/content/recognizer.js injects
// this iframe; the MAIN-world pipeline talks to us directly via postMessage.
//
//   MAIN → here (contentWindow msg): { __drawme_req: "load" | "frame" | "free", bitmap?, ts? }
//   here → MAIN (parent msg):        { __drawme_rec: "hello" | "model" | "result", ... }

(() => {
  "use strict";
  const api = (typeof browser !== "undefined" && browser) || (typeof chrome !== "undefined" && chrome) || null;
  const BASE = api && api.runtime && api.runtime.getURL ? api.runtime.getURL("") : location.origin + "/";
  const send = (msg) => {
    try {
      window.parent.postMessage(msg, "*");
    } catch (_) {}
  };

  let recognizer = null;
  let recognizerHands = null; // 2 or 1 — how many hands the loaded model tracks
  let loading = false;
  let lastTs = 0; // recognizeForVideo demands strictly increasing timestamps

  function reportModel(status, extra) {
    send({ __drawme_rec: "model", status, hands: recognizerHands, ...(extra || {}) });
  }

  async function loadModel() {
    if (recognizer || loading) return;
    loading = true;
    reportModel("loading", { stage: "import" });
    try {
      const vision = await import(BASE + "vendor/tasks-vision/vision_bundle.mjs");
      const { GestureRecognizer, FilesetResolver } = vision;
      const baseOpts = {
        baseOptions: { modelAssetPath: BASE + "vendor/tasks-vision/gesture_recognizer.task" },
        runningMode: "VIDEO",
        minHandDetectionConfidence: 0.3,
        minHandPresenceConfidence: 0.3,
        minTrackingConfidence: 0.35,
      };
      // Memory fallback ladder: reuse ONE WASM arena per hand-count "generation"
      // (GPU/CPU are just a graph option on the same arena); only the drop to one
      // hand gets a fresh arena (an OOM abort poisons the arena it hit). numHands:1
      // ~halves the working set so a constrained laptop still loads with one hand.
      const generations = [
        { numHands: 2, delegates: ["GPU", "CPU"] },
        { numHands: 1, delegates: ["GPU", "CPU"] },
      ];
      let lastErr = null;
      for (const gen of generations) {
        let fileset;
        try {
          fileset = await FilesetResolver.forVisionTasks(BASE + "vendor/tasks-vision");
        } catch (e) {
          lastErr = e;
          continue;
        }
        for (const delegate of gen.delegates) {
          try {
            reportModel("loading", { stage: `${delegate}·${gen.numHands}h` });
            const build = GestureRecognizer.createFromOptions(fileset, {
              ...baseOpts,
              numHands: gen.numHands,
              baseOptions: { ...baseOpts.baseOptions, delegate },
            });
            // GPU can HANG on a broken WebGL/driver stack — bound it; CPU can't.
            recognizer =
              delegate === "GPU"
                ? await Promise.race([
                    build,
                    new Promise((_, rej) => setTimeout(() => rej(new Error("GPU init timeout")), 8000)),
                  ])
                : await build;
            recognizerHands = gen.numHands;
            loading = false;
            reportModel("ready");
            return;
          } catch (e) {
            lastErr = e;
            console.warn(`[draw.me] recognizer ${delegate}/${gen.numHands}h failed`, e);
          }
        }
      }
      throw lastErr || new Error("all model load attempts failed");
    } catch (err) {
      loading = false;
      console.warn("[draw.me] recognizer load failed (iframe)", err);
      reportModel("error", { error: String((err && err.message) || err) || "load failed" });
    }
  }

  // Release the WASM arena back to the OS when no camera is being augmented.
  function freeModel() {
    if (!recognizer) return;
    const r = recognizer;
    recognizer = null;
    recognizerHands = null;
    try {
      if (typeof r.close === "function") r.close();
    } catch (_) {}
    reportModel("freed");
  }

  function onFrame(bitmap, ts) {
    if (!recognizer) {
      try {
        if (bitmap && bitmap.close) bitmap.close();
      } catch (_) {}
      if (!loading) loadModel();
      return;
    }
    const t = Math.max(Number(ts) || 0, lastTs + 1);
    lastTs = t;
    let res = null;
    try {
      res = recognizer.recognizeForVideo(bitmap, t);
    } catch (_) {
      /* transient — skip this frame */
    } finally {
      try {
        if (bitmap && bitmap.close) bitmap.close();
      } catch (_) {}
    }
    // Post ONLY plain, cloneable data (arrays of {x,y,z} + handedness categories).
    send({
      __drawme_rec: "result",
      landmarks: (res && res.landmarks) || [],
      handedness: (res && (res.handedness || res.handednesses)) || [],
      hands: recognizerHands,
    });
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m !== "object" || typeof m.__drawme_req !== "string") return;
    if (m.__drawme_req === "frame") onFrame(m.bitmap, m.ts);
    else if (m.__drawme_req === "load") loadModel();
    else if (m.__drawme_req === "free") freeModel();
  });

  // Tell MAIN the courier is ready; it (re)issues any pending load.
  send({ __drawme_rec: "hello" });
})();
