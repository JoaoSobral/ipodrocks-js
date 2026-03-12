import { create } from "zustand";

interface SavantState {
  isSavantTabActive: boolean;
  setSavantTabActive: (active: boolean) => void;
}

export const useSavantStore = create<SavantState>((set) => ({
  isSavantTabActive: false,
  setSavantTabActive: (active) => set({ isSavantTabActive: active }),
}));
