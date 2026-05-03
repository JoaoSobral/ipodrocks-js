import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddDeviceModal } from "../renderer/components/modals/AddDeviceModal";
import { addDevice } from "../renderer/ipc/api";

vi.mock("../renderer/ipc/api", () => ({
  addDevice: vi.fn().mockResolvedValue({ id: 1, name: "My iPod" }),
}));

function open() {
  return render(<AddDeviceModal open onClose={vi.fn()} />);
}

describe("AddDeviceModal", () => {
  it("button is enabled when fields are empty", () => {
    open();
    const btn = screen.getByRole("button", { name: /Add Device/i });
    expect(btn).not.toBeDisabled();
  });

  it("shows hints for both mandatory fields when submitted empty", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /Add Device/i }));
    expect(screen.getByText("Please enter a device name")).toBeInTheDocument();
    expect(screen.getByText("Please enter a mount path")).toBeInTheDocument();
  });

  it("shows only mount path hint when name is filled", () => {
    open();
    fireEvent.change(screen.getByPlaceholderText("e.g. iPod Classic"), {
      target: { value: "My iPod" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add Device/i }));
    expect(screen.queryByText("Please enter a device name")).not.toBeInTheDocument();
    expect(screen.getByText("Please enter a mount path")).toBeInTheDocument();
  });

  it("shows only device name hint when mount path is filled", () => {
    open();
    fireEvent.change(screen.getByPlaceholderText("/media/ipod"), {
      target: { value: "/mnt/ipod" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add Device/i }));
    expect(screen.getByText("Please enter a device name")).toBeInTheDocument();
    expect(screen.queryByText("Please enter a mount path")).not.toBeInTheDocument();
  });

  it("calls addDevice and shows no hints when both fields are filled", async () => {
    open();
    fireEvent.change(screen.getByPlaceholderText("e.g. iPod Classic"), {
      target: { value: "My iPod" },
    });
    fireEvent.change(screen.getByPlaceholderText("/media/ipod"), {
      target: { value: "/mnt/ipod" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add Device/i }));
    await waitFor(() => {
      expect(vi.mocked(addDevice)).toHaveBeenCalledWith(
        expect.objectContaining({ name: "My iPod", mountPath: "/mnt/ipod" })
      );
    });
    expect(screen.queryByText("Please enter a device name")).not.toBeInTheDocument();
    expect(screen.queryByText("Please enter a mount path")).not.toBeInTheDocument();
  });
});
