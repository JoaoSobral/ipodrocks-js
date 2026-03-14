import { useThemeStore } from "../../stores/theme-store";

/** Small round icon button to toggle dark/light theme. */
export function ThemeToggle() {
  const { theme, toggleTheme } = useThemeStore();
  const isLight = theme === "light";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="w-9 h-9 rounded-full flex items-center justify-center text-lg border border-border bg-secondary hover:bg-accent/50 transition-colors cursor-default"
      title={isLight ? "Switch to dark mode" : "Switch to light mode"}
      aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
    >
      {isLight ? "☀" : "☽"}
    </button>
  );
}
