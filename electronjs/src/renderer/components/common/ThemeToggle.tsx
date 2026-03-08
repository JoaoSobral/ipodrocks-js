import { useThemeStore } from "../../stores/theme-store";

/** Small round icon button to toggle dark/light theme. */
export function ThemeToggle() {
  const { theme, toggleTheme } = useThemeStore();
  const isLight = theme === "light";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="w-9 h-9 rounded-full flex items-center justify-center text-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-colors cursor-default [.theme-light_&]:border-[#e2e8f0] [.theme-light_&]:bg-[#f8f8f8] [.theme-light_&]:hover:bg-[#eee]"
      title={isLight ? "Switch to dark mode" : "Switch to light mode"}
      aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
    >
      {isLight ? "☀" : "☽"}
    </button>
  );
}
