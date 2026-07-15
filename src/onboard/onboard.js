// SoupDraw — onboarding cheat-sheet. Renders the gesture list from the SAME
// bindings source of truth the popup + pipeline use (window.DrawMeBindings.legend),
// reflecting the user's own rebindings if they've made any. Never drifts.
const api = typeof browser !== "undefined" ? browser : chrome;

async function render() {
  let bindings = null;
  try {
    const stored = await api.storage.local.get("settings");
    bindings = (stored.settings || {}).bindings || null;
  } catch (_) {
    /* fresh install / no storage yet → defaults */
  }

  const b = window.DrawMeBindings;
  const el = document.getElementById("cheatsheet");
  if (!b || !el) return;

  // Only gestures that actually do something (skip anything bound to "nothing").
  const items = b.legend(bindings).filter((g) => g.bound !== "none");

  el.replaceChildren();
  for (const g of items) {
    const card = document.createElement("div");
    card.className = "card";

    const ico = document.createElement("div");
    ico.className = "ico";
    ico.textContent = g.icon;

    const body = document.createElement("div");
    body.className = "body";

    const act = document.createElement("div");
    act.className = "act";
    act.textContent = g.action;

    const how = document.createElement("div");
    how.className = "how";
    how.textContent = g.how;

    body.append(act, how);
    card.append(ico, body);
    el.appendChild(card);
  }
}

// Show the ACTUAL registered shortcuts (platform-correct + reflects any remap the
// user made in about:addons). Chips are tagged with data-cmd = command name.
async function localizeShortcuts() {
  let cmds = [];
  try {
    cmds = await api.commands.getAll();
  } catch (_) {
    return; // keep the static defaults in the HTML
  }
  const map = {};
  for (const c of cmds) map[c.name] = (c.shortcut || "").replace(/Command/g, "Cmd").replace(/MacCtrl/g, "Ctrl");
  document.querySelectorAll(".kbd[data-cmd]").forEach((el) => {
    const s = map[el.dataset.cmd];
    if (s) el.textContent = s;
  });
}

render();
localizeShortcuts();
