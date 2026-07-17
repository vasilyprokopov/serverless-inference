"use strict";
/* Live dark/light theme, shared across pages. Dark is the default (projector-friendly).
   Runs from <head> so the saved theme is applied before first paint (no flash), then
   injects a fixed toggle once the body exists. Choice persists in localStorage. */
(function () {
  var KEY = "do-si-theme";
  var current = "dark";
  try { if (localStorage.getItem(KEY) === "light") current = "light"; } catch (_) {}

  function apply(t) { document.documentElement.setAttribute("data-theme", t); }
  apply(current); // pre-paint

  // monochrome inline SVGs (use currentColor, so they theme with the text)
  var SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M19.4 4.6l-1.7 1.7M6.3 17.7l-1.7 1.7"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function setup() {
    var btn = document.createElement("button");
    btn.className = "theme-toggle";
    btn.type = "button";
    // show the icon of the mode you'll switch TO
    var label = function () {
      btn.innerHTML = current === "dark" ? SUN : MOON;
      btn.setAttribute("aria-label", current === "dark" ? "switch to light theme" : "switch to dark theme");
    };
    label();
    btn.addEventListener("click", function () {
      current = current === "dark" ? "light" : "dark";
      apply(current);
      try { localStorage.setItem(KEY, current); } catch (_) {}
      label();
    });
    document.body.appendChild(btn);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();
