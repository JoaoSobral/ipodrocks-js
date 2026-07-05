// Applies the saved theme before first paint to avoid a flash of the wrong
// theme. Kept as an external file (not inline) so the CSP can forbid inline
// scripts (`script-src 'self'`).
try {
  if (localStorage.getItem("ipodrocks-theme") === "light") {
    document.documentElement.classList.remove("dark");
  } else {
    document.documentElement.classList.add("dark");
  }
} catch (_) {
  document.documentElement.classList.add("dark");
}
