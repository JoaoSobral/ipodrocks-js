import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WelcomePanel } from "../renderer/components/panels/WelcomePanel";

vi.mock("@assets/ipodRocks_transp.png?url", () => ({ default: "/mock-transp.png" }));
vi.mock("@assets/ipodRocks_black.png?url", () => ({ default: "/mock-black.png" }));

describe("WelcomePanel", () => {
  it("renders the app title", () => {
    render(<WelcomePanel />);
    expect(screen.getByText("iPodRocks")).toBeInTheDocument();
  });

  it("renders the features section", () => {
    render(<WelcomePanel />);
    expect(screen.getByText("Features")).toBeInTheDocument();
    expect(screen.getByText("What you can do with iPodRocks")).toBeInTheDocument();
  });

  it("renders Sync feature", () => {
    render(<WelcomePanel />);
    expect(screen.getByRole("heading", { name: "Sync" })).toBeInTheDocument();
  });

  it("renders Get started section", () => {
    render(<WelcomePanel />);
    expect(screen.getByText("Get started")).toBeInTheDocument();
    expect(screen.getByText(/Use the sidebar to navigate/)).toBeInTheDocument();
  });
});
