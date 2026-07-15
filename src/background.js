// draw.me — background: the keyboard command that arms/disarms drawing.
// Using the commands API (not a page key listener) means the shortcut is
// conflict-free with call apps and user-customizable in about:addons.
const api = typeof browser !== "undefined" ? browser : chrome;

api.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-draw") return;
  const stored = await api.storage.local.get("settings");
  const settings = { ...(stored.settings || {}) };
  settings.active = !settings.active;
  await api.storage.local.set({ settings });
});
