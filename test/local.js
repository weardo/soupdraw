// SoupDraw — test harness driver. Calls getUserMedia like a call app would.
const v = document.getElementById("v");
const log = document.getElementById("log");

// Gesture legend — rendered from the shared bindings file (single source of
// truth), so it always matches what the extension actually does.
(function renderLegend() {
  const el = document.getElementById("legend");
  const b = window.DrawMeBindings;
  if (!el || !b) return;
  const h = document.createElement("h2");
  h.textContent = "Gestures";
  el.appendChild(h);
  for (const row of b.legend().filter((r) => r.bound !== "none")) {
    const ico = document.createElement("div");
    ico.className = "ico";
    ico.textContent = row.icon;
    const txt = document.createElement("div");
    txt.className = "txt";
    const strong = document.createElement("b");
    strong.textContent = row.action;
    txt.append(row.how + " → ", strong);
    if (row.detail) {
      const det = document.createElement("div");
      det.className = "det";
      det.textContent = row.detail;
      txt.appendChild(det);
    }
    el.append(ico, txt);
  }
})();
let stream = null;
let fpsFrames = 0;
let fpsClock = performance.now();
let liveFps = 0;
let meterOn = false;
let baseInfo = "";

// Canvas captureStream tracks don't report frameRate in getSettings(), so we
// measure the delivered FPS directly from the video element's frame callbacks.
function meter() {
  if (!meterOn) return;
  fpsFrames++;
  const now = performance.now();
  if (now - fpsClock >= 500) {
    liveFps = Math.round((fpsFrames * 1000) / (now - fpsClock));
    fpsFrames = 0;
    fpsClock = now;
    render();
  }
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) v.requestVideoFrameCallback(meter);
  else requestAnimationFrame(meter);
}
function render() {
  log.textContent = `${baseInfo}\nmeasured: ${liveFps} fps · ${v.videoWidth}x${v.videoHeight}`;
}

async function start() {
  if (stream) return; // already running
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    v.srcObject = stream;
    const t = stream.getVideoTracks()[0];
    const s = t.getSettings();
    const augmented = !t.label;
    v.classList.toggle("mirror", !augmented);
    baseInfo =
      `track: "${t.label || "(no label — augmented canvas stream)"}"\n` +
      `resolution: ${s.width || "?"}x${s.height || "?"} ` +
      `(canvas tracks don't report fps — measuring below)\n` +
      `preview: ${augmented ? "canvas mirror (from extension)" : "css mirror (raw camera)"}`;
    render();
    meterOn = true;
    fpsClock = performance.now();
    fpsFrames = 0;
    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) v.requestVideoFrameCallback(meter);
    else requestAnimationFrame(meter);
  } catch (e) {
    log.textContent = "getUserMedia error: " + e + "\n(click Start camera to retry / grant permission)";
    stream = null;
  }
}

document.getElementById("start").onclick = start;
document.getElementById("stop").onclick = () => {
  meterOn = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  v.srcObject = null;
  stream = null;
  log.textContent = "stopped";
};

// Auto-start on load. The first time, Firefox shows the camera permission
// prompt; once granted for this origin it starts silently on every load.
start();
