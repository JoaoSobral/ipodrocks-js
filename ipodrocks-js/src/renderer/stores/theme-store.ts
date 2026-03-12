import { create } from "zustand";

const STORAGE_KEY = "ipodrocks-theme";

export type Theme = "dark" | "light";

function readStored(): Theme {
  if (typeof window === "undefined") return "dark";
  const v = localStorage.getItem(STORAGE_KEY);
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
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, theme);
    set({ theme });
  },
  toggleTheme: () => {
    set((s) => {
      const next: Theme = s.theme === "dark" ? "light" : "dark";
      if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, next);
      return { theme: next };
    });
  },
}));
