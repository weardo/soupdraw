// draw.me — recognizer host injector (ISOLATED content-script world)
//
// The hand model runs in an EXTENSION-ORIGIN IFRAME (src/offscreen/recognizer.html),
// the one context that escapes the page's CSP entirely — including the
// require-trusted-types-for that blocks a content-script Worker, and the wasm/import
// blocks that hit the MAIN world. See recognizer-frame.js for the full rationale.
//
// This file's ONLY job: inject that hidden iframe into the page. A content script
// (not the MAIN world) does the injection so Firefox treats it as an extension
// frame. Once loaded, the iframe and the MAIN-world pipeline talk to each other
// DIRECTLY via postMessage (pipeline finds the iframe by id); we don't relay.

(() => {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const IFRAME_ID = "__drawme_recognizer_host";

  function inject() {
    if (document.getElementById(IFRAME_ID)) return true;
    const root = document.body || document.documentElement;
    if (!root) return false;
    const f = document.createElement("iframe");
    f.id = IFRAME_ID;
    f.src = api.runtime.getURL("src/offscreen/recognizer.html");
    f.setAttribute("aria-hidden", "true");
    f.setAttribute("tabindex", "-1");
    // Headless: zero-size, off-screen, non-interactive, never visible.
    f.style.cssText =
      "position:fixed!important;width:1px;height:1px;border:0;opacity:0;pointer-events:none;left:-9999px;top:-9999px;z-index:-1;";
    root.appendChild(f);
    return true;
  }

  // We run at document_start, so <body> may not exist yet — retry until it does.
  if (!inject()) {
    const retry = () => {
      if (inject()) {
        document.removeEventListener("DOMContentLoaded", retry);
        clearInterval(timer);
      }
    };
    document.addEventListener("DOMContentLoaded", retry);
    const timer = setInterval(retry, 100);
  }
})();
