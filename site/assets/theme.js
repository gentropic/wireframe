/* First-paint theme, shared with gentropic.org (same key): stored → OS → dark. Classic script in <head>. */
(function () {
  try {
    var t = localStorage.getItem('gcu-theme');
    if (t !== 'light' && t !== 'dark') t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch (e) { document.documentElement.setAttribute('data-theme', 'dark'); }
})();
