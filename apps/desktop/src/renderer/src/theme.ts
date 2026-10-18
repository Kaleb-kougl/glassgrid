import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { isThemePreference, type GlassgridBridge, type ThemePreference } from '@glassgrid/core';
import type { ThemeName } from '@glassgrid/ui/tokens';

/** localStorage key of the View → Theme override. */
export const THEME_STORAGE_KEY = 'glassgrid.theme';

export function readThemePreference(storage: Pick<Storage, 'getItem'> | undefined): ThemePreference {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeToSystem(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ThemeName {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

/**
 * The window's theme: follows the OS (`prefers-color-scheme`) unless View →
 * Theme overrides it; the override persists in localStorage. Sets
 * `data-gg-theme` on the document root and tells main, which colours the
 * native chrome and ticks the menu item.
 */
export function useTheme(bridge: Pick<GlassgridBridge, 'setTheme'>) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readThemePreference(safeStorage()));
  const systemDark = useSyncExternalStore(subscribeToSystem, systemPrefersDark, () => true);
  const theme = resolveTheme(preference, systemDark);

  useEffect(() => {
    document.documentElement.dataset['ggTheme'] = theme;
  }, [theme]);

  useEffect(() => {
    bridge.setTheme(preference);
  }, [bridge, preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      if (next === 'system') safeStorage()?.removeItem(THEME_STORAGE_KEY);
      else safeStorage()?.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
  }, []);

  return { preference, theme, setPreference };
}
