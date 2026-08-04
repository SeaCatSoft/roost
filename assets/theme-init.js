/* Runs before first paint so the page never flashes the wrong appearance.
   Kept separate from motion.js, which is deferred until the DOM is ready. */
(function () {
  'use strict';

  var KEY = 'roost-appearance';
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var btn = document.getElementById('themeToggle');
    if (btn) btn.setAttribute('aria-pressed', String(theme === 'dark'));
  }

  var saved = stored();
  if (saved) apply(saved);   // no saved choice: the CSS follows the OS on its own

  // The toggle itself is wired once the button exists.
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;

    var current = function () {
      return root.getAttribute('data-theme') ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    };

    btn.setAttribute('aria-pressed', String(current() === 'dark'));

    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
    });
  });
})();
