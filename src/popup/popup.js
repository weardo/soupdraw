// draw.me — popup: reads/writes settings, shows live status.
const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULTS = { enabled: true, active: true, mirror: true, boost: true, assist: true, debug: true, minimap: true, history: true, spotlight: true, color: "#ff2d55", size: 6, clearNonce: 0, undoNonce: 0, redoNonce: 0, bindings: { ...window.DrawMeBindings.DEFAULT_BINDINGS } };
const COLORS = ["#ff2d55", "#ffcc00", "#35c759", "#0a84ff", "#ffffff", "#000000"];

const els = {
  enabled: document.getElementById("enabled"),
  enabledHint: document.getElementById("enabledHint"),
  active: document.getElementById("active"),
  armHint: document.getElementById("armHint"),
  mirror: document.getElementById("mirror"),
  boost: document.getElementById("boost"),
  assist: document.getElementById("assist"),
  minimap: document.getElementById("minimap"),
  history: document.getElementById("history"),
  spotlight: document.getElementById("spotlight"),
  debug: document.getElementById("debug"),
  undo: document.getElementById("undo"),
  redo: document.getElementById("redo"),
  resetBindings: document.getElementById("resetBindings"),
  size: document.getElementById("size"),
  sizeVal: document.getElementById("sizeVal"),
  swatches: document.getElementById("swatches"),
  clear: document.getElementById("clear"),
  dot: document.getElementById("dot"),
  statusText: document.getElementById("statusText"),
};

let settings = { ...DEFAULTS };

async function load() {
  const stored = await api.storage.local.get("settings");
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  // bindings is a nested object — merge it so a partial stored map keeps defaults.
  settings.bindings = { ...DEFAULTS.bindings, ...((stored.settings || {}).bindings || {}) };
  render();
}

function render() {
  els.enabled.checked = settings.enabled;
  els.enabledHint.textContent = settings.enabled
    ? "On — apps see your augmented feed"
    : "Off — apps see your real camera";
  els.active.checked = settings.active;
  els.armHint.textContent = settings.active
    ? "Armed — gestures live"
    : "Disarmed — gestures ignored (safe for calls)";
  els.mirror.checked = settings.mirror;
  els.boost.checked = settings.boost;
  els.assist.checked = settings.assist;
  els.minimap.checked = settings.minimap;
  els.history.checked = settings.history;
  els.spotlight.checked = settings.spotlight;
  els.debug.checked = settings.debug;
  els.size.value = settings.size;
  els.sizeVal.textContent = settings.size;
  renderSwatches();
  renderGestures();
}

function renderSwatches() {
  els.swatches.replaceChildren();
  for (const c of COLORS) {
    const b = document.createElement("div");
    b.className = "swatch" + (c.toLowerCase() === settings.color.toLowerCase() ? " active" : "");
    b.style.background = c;
    b.title = c;
    b.addEventListener("click", () => update({ color: c }));
    els.swatches.appendChild(b);
  }
}

async function update(patch) {
  settings = { ...settings, ...patch };
  await api.storage.local.set({ settings });
  render();
}

els.enabled.addEventListener("change", () => update({ enabled: els.enabled.checked }));
els.active.addEventListener("change", () => update({ active: els.active.checked }));
els.mirror.addEventListener("change", () => update({ mirror: els.mirror.checked }));
els.boost.addEventListener("change", () => update({ boost: els.boost.checked }));
els.assist.addEventListener("change", () => update({ assist: els.assist.checked }));
els.minimap.addEventListener("change", () => update({ minimap: els.minimap.checked }));
els.history.addEventListener("change", () => update({ history: els.history.checked }));
els.spotlight.addEventListener("change", () => update({ spotlight: els.spotlight.checked }));
els.debug.addEventListener("change", () => update({ debug: els.debug.checked }));
els.undo.addEventListener("click", () => update({ undoNonce: (settings.undoNonce || 0) + 1 }));
els.redo.addEventListener("click", () => update({ redoNonce: (settings.redoNonce || 0) + 1 }));
els.resetBindings.addEventListener("click", () => update({ bindings: { ...window.DrawMeBindings.DEFAULT_BINDINGS } }));
els.size.addEventListener("input", () => {
  els.sizeVal.textContent = els.size.value;
  update({ size: Number(els.size.value) });
});
els.clear.addEventListener("click", () => update({ clearNonce: (settings.clearNonce || 0) + 1 }));

// Live status polling while the popup is open.
async function pollStatus() {
  const { status } = await api.storage.local.get("status");
  const fresh = status && Date.now() - status.ts < 2500;
  if (!settings.enabled) {
    setStatus("off", "Disabled");
  } else if (!fresh || !status.running) {
    setStatus("warn", "Waiting for a camera request…");
  } else if (!status.armed) {
    setStatus("off", "Disarmed · Alt+Shift+D to draw");
  } else if (!status.modelReady) {
    setStatus("warn", "Loading hand model…");
  } else if (status.hand) {
    const g = status.gesture ? status.gesture.replace(/_/g, " ") : "…";
    const act = status.erasing
      ? "Erasing"
      : status.transforming
        ? "Transforming canvas"
        : status.drawing
          ? "Drawing"
          : `Gesture: ${g}`;
    setStatus("live", `${act} · ${status.fps} fps`);
  } else {
    setStatus("live", `Live · no hand · ${status.fps} fps`);
  }
}
function setStatus(cls, text) {
  els.dot.className = "dot" + (cls === "live" ? " live" : cls === "warn" ? " warn" : "");
  els.statusText.textContent = text;
}

// User-defined controls: one row per gesture with a dropdown that rebinds it.
// Gesture list + action catalog come from the shared bindings file (single
// source of truth); the chosen bindings live in settings.bindings.
function renderGestures() {
  const el = document.getElementById("gestures");
  const b = window.DrawMeBindings;
  if (!el || !b) return;
  el.replaceChildren();
  for (const gesture of b.ALL) {
    const row = document.createElement("div");
    row.className = "g";

    const ico = document.createElement("span");
    ico.className = "ico";
    ico.textContent = gesture.icon;

    const how = document.createElement("span");
    how.className = "how";
    how.textContent = gesture.label;

    const sel = document.createElement("select");
    sel.className = "bind";
    for (const a of b.ACTIONS_CATALOG) {
      const opt = document.createElement("option");
      opt.value = a.name;
      opt.textContent = a.label;
      sel.appendChild(opt);
    }
    sel.value = (settings.bindings && settings.bindings[gesture.name]) || b.DEFAULT_BINDINGS[gesture.name] || "none";
    sel.addEventListener("change", () => {
      update({ bindings: { ...settings.bindings, [gesture.name]: sel.value } });
    });

    row.append(ico, how, sel);
    el.appendChild(row);
  }
}

load();
setInterval(pollStatus, 500);
pollStatus();
