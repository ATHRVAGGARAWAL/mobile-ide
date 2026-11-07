import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { themes, type Theme } from '../theme';
import { useSettings } from '../state/settings';

const ThemeContext = createContext<Theme>(themes.dark);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const pref = useSettings((s) => s.theme);
  const system = useColorScheme();
  const theme = useMemo(() => {
    const name = pref === 'system' ? (system === 'light' ? 'light' : 'dark') : pref;
    return themes[name];
  }, [pref, system]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
