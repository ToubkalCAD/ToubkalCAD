// ============================================================
// ToubkalCAD – theme.ts
// Phase 9 – light/dark theme persistence + toggle.
// Sets data-theme on <html>; chrome flips via CSS variables.
// Broadcasts 'cad-theme-changed' so the 3D viewport can recolour.
// ============================================================

export type Theme = 'light' | 'dark';
const KEY = 'toubkalcad-theme';

export function getTheme(): Theme {
  return (document.documentElement.getAttribute('data-theme') as Theme) ?? 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(KEY, theme); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('cad-theme-changed', { detail: { theme } }));
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

/** Call once at startup to restore the saved theme. */
export function initTheme(): Theme {
  let saved: Theme = 'light';
  try { saved = (localStorage.getItem(KEY) as Theme) || 'light'; } catch { /* ignore */ }
  document.documentElement.setAttribute('data-theme', saved);
  return saved;
}
