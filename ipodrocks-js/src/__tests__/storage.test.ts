/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { safeLocalStorage } from "../renderer/utils/storage";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safeLocalStorage", () => {
  it("returns the localStorage object when available", () => {
    const mock = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    vi.stubGlobal("localStorage", mock);
    expect(safeLocalStorage()).toBe(mock);
  });

  it("returns null when localStorage is undefined", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(safeLocalStorage()).toBeNull();
  });

  it("returns null when localStorage.getItem is not a function", () => {
    vi.stubGlobal("localStorage", { getItem: "not-a-function" });
    expect(safeLocalStorage()).toBeNull();
  });

  it("returns null when accessing localStorage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      get() { throw new Error("SecurityError"); },
      configurable: true,
    });
    expect(safeLocalStorage()).toBeNull();
  });
});
