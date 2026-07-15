// draw.me — background: the keyboard command that arms/disarms drawing.
// Using the commands API (not a page key listener) means the shortcut is
// conflict-free with call apps and user-customizable in about:addons.
const api = typeof browser !== "undefined" ? browser : chrome;

// Keyboard commands. Arm/disarm toggles the armed flag; undo/redo bump the same
// nonces the popup buttons use, so they work hands-free mid-draw. All customizable
// in about:addons > Manage Extension Shortcuts.
api.commands.onCommand.addListener(async (command) => {
  const stored = await api.storage.local.get("settings");
  const settings = { ...(stored.settings || {}) };
  if (command === "toggle-draw") settings.active = !settings.active;
  else if (command === "undo") settings.undoNonce = (settings.undoNonce || 0) + 1;
  else if (command === "redo") settings.redoNonce = (settings.redoNonce || 0) + 1;
  else return;
  await api.storage.local.set({ settings });
});

// First install → open the welcome + how-to page so the gestures are learnable.
api.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    api.tabs.create({ url: api.runtime.getURL("src/onboard/onboard.html") });
  }
});
