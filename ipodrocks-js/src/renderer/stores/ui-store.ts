import { create } from "zustand";

interface UIState {
  openSettings: (() => void) | null;
  setOpenSettings: (fn: (() => void) | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  openSettings: null,
  setOpenSettings: (fn) => set({ openSettings: fn }),
}));
