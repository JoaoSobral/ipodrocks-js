import { create } from "zustand";

interface UIState {
  openSettings: (() => void) | null;
  setOpenSettings: (fn: (() => void) | null) => void;
  navigateTo: ((panel: string) => void) | null;
  setNavigateTo: (fn: ((panel: string) => void) | null) => void;
  pendingSyncDeviceId: number | null;
  setPendingSyncDeviceId: (id: number | null) => void;
  pendingLibraryScan: boolean;
  setPendingLibraryScan: (v: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  openSettings: null,
  setOpenSettings: (fn) => set({ openSettings: fn }),
  navigateTo: null,
  setNavigateTo: (fn) => set({ navigateTo: fn }),
  pendingSyncDeviceId: null,
  setPendingSyncDeviceId: (id) => set({ pendingSyncDeviceId: id }),
  pendingLibraryScan: false,
  setPendingLibraryScan: (v) => set({ pendingLibraryScan: v }),
}));
