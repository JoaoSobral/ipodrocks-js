import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DevicePanel } from "../renderer/components/panels/DevicePanel";

vi.mock("../renderer/ipc/api", () => ({
  getDevices: vi.fn().mockResolvedValue([]),
  addDevice: vi.fn().mockResolvedValue(undefined),
  updateDevice: vi.fn().mockResolvedValue(undefined),
  removeDevice: vi.fn().mockResolvedValue(undefined),
  checkDevice: vi.fn().mockResolvedValue({}),
  pickFolder: vi.fn().mockResolvedValue({ path: null }),
  getDeviceModels: vi.fn().mockResolvedValue([]),
  getCodecConfigs: vi.fn().mockResolvedValue([]),
  setDefaultDevice: vi.fn().mockResolvedValue(undefined),
  getDefaultDeviceId: vi.fn().mockResolvedValue(null),
  getShadowLibraries: vi.fn().mockResolvedValue([]),
  isMpcencAvailable: vi.fn().mockResolvedValue(false),
  getMpcRemindDisabled: vi.fn().mockResolvedValue(false),
  setMpcRemindDisabled: vi.fn().mockResolvedValue(undefined),
}));

describe("DevicePanel", () => {
  it("renders device panel", () => {
    render(<DevicePanel />);
    expect(screen.getByText("+ Add Device")).toBeInTheDocument();
  });
});
