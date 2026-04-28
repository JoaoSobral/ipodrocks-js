export function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") return null;
    return localStorage;
  } catch {
    return null;
  }
}
