// draw.me — content bridge (isolated world)
// Only responsibility: shuttle config/settings between browser.storage (popup)
// and the MAIN-world pipeline, and pass it the extension base URL so it can
// build moz-extension:// asset URLs. No drawing logic lives here.

const api = typeof browser !== "undefined" ? browser : chrome;
const BASE = api.runtime.getURL(""); // e.g. moz-extension://<uuid>/

const DEFAULTS = {
  enabled: true,
  active: true, // drawing armed? (gestures only interpreted when true)
  mirror: true,
  preview: false, // on-page panel showing exactly what viewers receive
  boost: true,
  assist: true,
  debug: false, // gesture overlay is drawn on the OUTPUT — off by default so viewers don't see it
  minimap: true,
  history: true,
  spotlight: true,
  hideCamera: false,
  boardColor: "#14151a",
  color: "#ff2d55",
  size: 6,
  clearNonce: 0,
  undoNonce: 0,
  redoNonce: 0,
  calibNonce: 0,
  pinchDown: null,
  pinchUp: null,
};

const ORIGIN = window.location.origin === "null" ? "*" : window.location.origin;

function postConfig(settings) {
  window.postMessage({ __drawme: "config", base: BASE, settings }, ORIGIN);
}

// Send the saved drawing (board + history) to the MAIN-world pipeline.
async function postRestore() {
  const { drawing } = await api.storage.local.get("drawing");
  if (drawing) window.postMessage({ __drawme: "restore", drawing }, ORIGIN);
}

async function loadSettings() {
  const stored = await api.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

// 1) Push config + any saved drawing as early as possible.
loadSettings().then(postConfig);
postRestore();

// 2) The pipeline may load after us; answer its "ready" ping with fresh config.
window.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.__drawme === "ready") {
    loadSettings().then(postConfig);
    postRestore();
  }

  // Pipeline reports a changed board → persist it (best-effort, latest wins).
  if (msg.__drawme === "persist" && msg.drawing) {
    api.storage.local.set({ drawing: msg.drawing });
  }

  // Pipeline finished calibration → save the measured pinch thresholds.
  if (msg.__drawme === "calibrated" && msg.thresholds) {
    loadSettings().then((s) => api.storage.local.set({ settings: { ...s, ...msg.thresholds } }));
  }

  // Pipeline reports live status; stash it so the popup can read it.
  if (msg.__drawme === "status" && msg.status) {
    api.storage.local.set({ status: { ...msg.status, ts: Date.now() } });
  }

  // Pipeline asks to disarm (idle auto-disarm) — clear the armed flag.
  if (msg.__drawme === "disarm") {
    loadSettings().then((s) => {
      if (s.active) api.storage.local.set({ settings: { ...s, active: false } });
    });
  }
});

// 3) Live-update the pipeline whenever the popup changes settings.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  postConfig({ ...DEFAULTS, ...changes.settings.newValue });
});
