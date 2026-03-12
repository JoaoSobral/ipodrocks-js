import { create } from "zustand";
import { getDevices } from "../ipc/api";
import type { DeviceProfile } from "../ipc/api";

export type { DeviceProfile };

interface DeviceState {
  devices: DeviceProfile[];
  loading: boolean;
  error: string | null;
  fetchDevices: () => Promise<void>;
}

export const useDeviceStore = create<DeviceState>((set) => ({
  devices: [],
  loading: false,
  error: null,

  fetchDevices: async () => {
    set({ loading: true, error: null });
    try {
      const devices = await getDevices();
      set({ devices, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },
}));
