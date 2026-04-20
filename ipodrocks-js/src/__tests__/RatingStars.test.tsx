import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RatingStars } from "../renderer/components/RatingStars";

vi.mock("@shared/ratings", () => ({
  rocksToStars: (r: number | null) => (r == null ? null : r / 2),
  starsToRocks: (s: number | null) => {
    if (s == null) return null;
    const v = Math.round(s * 2);
    if (v < 0 || v > 10) throw new RangeError(`invalid stars value: ${s}`);
    return v;
  },
}));

describe("RatingStars", () => {
  it("renders 5 star buttons", () => {
    render(<RatingStars rating={null} />);
    const buttons = screen.getAllByRole("button", { name: /star/i });
    expect(buttons).toHaveLength(5);
  });

  it("shows conflict badge when hasConflict is true", () => {
    render(<RatingStars rating={6} hasConflict />);
    expect(screen.getByTitle(/conflict/i)).toBeInTheDocument();
  });

  it("shows device badge when fromDevice is true and no conflict", () => {
    render(<RatingStars rating={6} fromDevice />);
    expect(screen.getByTitle(/Rating from device/i)).toBeInTheDocument();
  });

  it("does not show device badge when hasConflict overrides it", () => {
    render(<RatingStars rating={6} fromDevice hasConflict />);
    expect(screen.queryByTitle(/Rating from device/i)).not.toBeInTheDocument();
    expect(screen.getByTitle(/conflict/i)).toBeInTheDocument();
  });

  it("calls onChange with Rockbox value when a star is clicked", () => {
    const onChange = vi.fn();
    render(<RatingStars rating={null} onChange={onChange} />);
    const stars = screen.getAllByRole("button", { name: /star/i });
    fireEvent.click(stars[2]); // 3rd star → 3 stars → 6 rocks
    expect(onChange).toHaveBeenCalledWith(6);
  });

  it("calls onChange with null when clicking the currently filled star", () => {
    const onChange = vi.fn();
    // rating=6 = 3 stars; click 3rd star to clear
    render(<RatingStars rating={6} onChange={onChange} />);
    const stars = screen.getAllByRole("button", { name: /star/i });
    fireEvent.click(stars[2]);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("does not call onChange when readonly", () => {
    const onChange = vi.fn();
    render(<RatingStars rating={6} onChange={onChange} readonly />);
    const stars = screen.getAllByRole("button", { name: /star/i });
    fireEvent.click(stars[0]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
