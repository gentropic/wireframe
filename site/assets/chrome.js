// shared page chrome: the light/dark toggle (persisted under gentropic.org's own key)
const btn = document.getElementById('themeToggle');
if (btn) btn.onclick = () => {
  const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
  if (dark) document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('gcu-theme', dark ? 'dark' : 'light'); } catch { /* private mode */ }
};
