import { useState } from "react";
import { rocksToStars, starsToRocks } from "@shared/ratings";

interface RatingStarsProps {
  /** Canonical rating 0–10. Null = unrated. */
  rating: number | null;
  /** Called with 0–10 Rockbox value (or null to clear). */
  onChange?: (rating: number | null) => void;
  /** Whether to show a small device icon badge when source is a device. */
  fromDevice?: boolean;
  /** Whether there is an unresolved conflict. */
  hasConflict?: boolean;
  readonly?: boolean;
  size?: "sm" | "md";
}

/**
 * Five-star rating display and input.
 * Click a filled star to clear; click empty star to set integer rating.
 * Shift+click to set half-star. Uses Rockbox 0–10 internally.
 */
export function RatingStars({
  rating,
  onChange,
  fromDevice = false,
  hasConflict = false,
  readonly = false,
  size = "sm",
}: RatingStarsProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  const starsValue = rocksToStars(rating) ?? 0;
  const displayStars = hovered !== null ? hovered : starsValue;

  const starSize = size === "sm" ? "text-xs" : "text-sm";

  function handleClick(starIndex: number, e: React.MouseEvent) {
    if (!onChange || readonly) return;
    const halfStar = e.shiftKey ? 0.5 : 0;
    const clicked = starIndex + 1 - halfStar;
    if (clicked === starsValue) {
      // Clicking same star clears rating
      onChange(null);
    } else {
      try {
        onChange(starsToRocks(clicked));
      } catch {
        onChange(starsToRocks(starIndex + 1));
      }
    }
  }

  function handleMouseMove(starIndex: number, e: React.MouseEvent) {
    if (readonly) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const inLeft = e.clientX - rect.left < rect.width / 2;
    setHovered(starIndex + (inLeft ? 0.5 : 1));
  }

  const stars = Array.from({ length: 5 }, (_, i) => {
    const fill = displayStars >= i + 1 ? 1 : displayStars >= i + 0.5 ? 0.5 : 0;
    return { fill };
  });

  return (
    <span className="inline-flex items-center gap-0.5">
      {stars.map((star, i) => (
        <button
          key={i}
          type="button"
          className={`${starSize} leading-none focus:outline-none ${
            readonly ? "cursor-default" : "cursor-pointer"
          }`}
          onMouseMove={(e) => handleMouseMove(i, e)}
          onMouseLeave={() => setHovered(null)}
          onClick={(e) => handleClick(i, e)}
          aria-label={`${i + 1} star`}
          tabIndex={readonly ? -1 : 0}
        >
          {star.fill === 1 ? (
            <span className="text-yellow-400">★</span>
          ) : star.fill === 0.5 ? (
            <span
              className="relative inline-block"
              style={{ width: "1em" }}
            >
              <span className="text-muted-foreground/30">★</span>
              <span
                className="absolute inset-0 overflow-hidden text-yellow-400"
                style={{ width: "50%" }}
              >
                ★
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground/30">★</span>
          )}
        </button>
      ))}
      {fromDevice && !hasConflict && (
        <span className="text-[9px] text-primary ml-0.5" title="Rating from device">
          ⊕
        </span>
      )}
      {hasConflict && (
        <span className="text-[9px] text-orange-400 ml-0.5" title="Rating conflict — click to resolve">
          ●
        </span>
      )}
    </span>
  );
}
