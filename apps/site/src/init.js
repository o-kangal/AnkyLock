// Runs in <head> before the first paint, as a file because the CSP allows no inline script.
// Applies the visitor's saved theme, and sends a first-time visitor whose browser prefers Turkish
// to the Turkish version of an English page. Keys match src/site.ts.
(function () {
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem('ankylock.site.theme');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    var turkish = root.getAttribute('data-tr');
    var preferred = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    if (turkish && localStorage.getItem('ankylock.site.language') === null && /^tr\b/i.test(preferred)) {
      location.replace(turkish + location.hash);
    }
  } catch {
    // Storage may be blocked; the page then follows the system theme and stays in English.
  }
})();
