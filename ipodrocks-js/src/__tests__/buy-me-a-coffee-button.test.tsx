// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@assets/buy_me_a_coffee.png?url", () => ({ default: "buy_me_a_coffee.png" }));

const openExternalMock = vi.fn((_url: string) => Promise.resolve());
vi.mock("../renderer/ipc/api", () => ({
  openExternal: (url: string) => openExternalMock(url),
}));

import { BuyMeACoffeeButton } from "../renderer/components/common/BuyMeACoffeeButton";

describe("BuyMeACoffeeButton", () => {
  beforeEach(() => {
    openExternalMock.mockClear();
  });

  it("renders an accessible button with the coffee image", () => {
    render(<BuyMeACoffeeButton />);
    const button = screen.getByRole("button", { name: /buy me a coffee/i });
    expect(button).toBeInTheDocument();
    const img = screen.getByAltText(/buy me a coffee/i) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("buy_me_a_coffee.png");
  });

  it("opens the buymeacoffee.com/vador URL when clicked", () => {
    render(<BuyMeACoffeeButton />);
    fireEvent.click(screen.getByRole("button", { name: /buy me a coffee/i }));
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    expect(openExternalMock).toHaveBeenCalledWith("https://buymeacoffee.com/vador");
  });
});
