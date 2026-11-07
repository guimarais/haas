(() => {
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try {
    const saved = localStorage.getItem('haas-theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch { /* Theme switching still works when browser storage is unavailable. */ }

  function updateTheme() {
    const dark = (preference || (systemTheme.matches ? 'dark' : 'light')) === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const button = document.getElementById('theme-toggle');
    if (button) {
      button.textContent = dark ? '☀' : '☾';
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      button.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    }
  }

  // Run before the stylesheet loads so a saved dark theme does not flash light.
  updateTheme();
  systemTheme.addEventListener('change', updateTheme);
  document.addEventListener('DOMContentLoaded', () => {
    updateTheme();
    document.getElementById('theme-toggle').addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('haas-theme', preference); } catch { /* Keep this visit's choice. */ }
      updateTheme();
    });
  });
})();
