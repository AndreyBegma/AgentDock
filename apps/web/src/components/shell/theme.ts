export const THEME_STORAGE_KEY = 'ad-theme';

export const THEME_MODES = ['system', 'dark', 'light'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_LABEL: Record<ThemeMode, string> = {
  system: 'System',
  dark: 'Dark',
  light: 'Light',
};

/**
 * Runs inline in `<head>` before first paint (spec D7), so the page never
 * flashes the wrong theme. Keep it dependency-free: it is a string, not a module.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){var d=document.documentElement;try{var m=localStorage.getItem('${THEME_STORAGE_KEY}');var t=m==='dark'||m==='light'?m:(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');d.setAttribute('data-theme',t)}catch(e){d.setAttribute('data-theme','dark')}})()`;

export const isThemeMode = (value: unknown): value is ThemeMode =>
  THEME_MODES.some((mode) => mode === value);

/** The concrete theme a mode resolves to right now. */
export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function readStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function storeTheme(mode: ThemeMode): void {
  try {
    if (mode === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
}
