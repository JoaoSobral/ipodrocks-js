import { create } from "zustand";
import { safeLocalStorage } from "../utils/storage";

const STORAGE_KEY = "ipodrocks-theme";

export type Theme = "dark" | "light";

function readStored(): Theme {
  const v = safeLocalStorage()?.getItem(STORAGE_KEY);
  return v === "light" ? "light" : "dark";
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: readStored(),
  setTheme: (theme: Theme) => {
    safeLocalStorage()?.setItem(STORAGE_KEY, theme);
    set({ theme });
  },
  toggleTheme: () => {
    set((s) => {
      const next: Theme = s.theme === "dark" ? "light" : "dark";
      safeLocalStorage()?.setItem(STORAGE_KEY, next);
      return { theme: next };
    });
  },
}));
