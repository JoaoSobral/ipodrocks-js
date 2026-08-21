import { useRef, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Label } from "./Label";
import { InfoTooltip } from "./InfoTooltip";

export interface SelectOption {
  value: string;
  label: string;
  /**
   * Optional heading this option sits under. Consecutive options sharing a
   * group render beneath one header; ungrouped options render as before.
   */
  group?: string;
  /** Secondary text shown to the right, e.g. a USB id. */
  detail?: string;
}

interface SelectProps {
  label?: string;
  tooltip?: string;
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  hint?: string;
  testId?: string;
}

export function Select({
  label,
  tooltip,
  options: optionsProp,
  value = "",
  onChange,
  placeholder = "Select…",
  className = "",
  disabled = false,
  hint,
  testId,
}: SelectProps) {
  const options = Array.isArray(optionsProp) ? optionsProp : [];
  const [open, setOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  function openDropdown() {
    if (disabled) return;
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const GAP = 4; // gap between button and dropdown
      const MARGIN = 8; // keep-away from viewport edge
      const MAX_H = 224; // max-h-56 = 14rem = 224px
      const spaceBelow = window.innerHeight - rect.bottom - GAP - MARGIN;
      const spaceAbove = rect.top - GAP - MARGIN;
      // Prefer opening downward; flip up only when the list can't fit fully
      // below and there is more room above.
      const openDown = spaceBelow >= MAX_H || spaceBelow >= spaceAbove;
      const maxHeight = Math.max(Math.min(MAX_H, openDown ? spaceBelow : spaceAbove), 96);
      setDropdownStyle(
        openDown
          ? { top: rect.bottom + GAP, left: rect.left, width: rect.width, maxHeight }
          : { bottom: window.innerHeight - rect.top + GAP, left: rect.left, width: rect.width, maxHeight }
      );
    }
    setOpen((o) => !o);
  }

  const selected = options.find((o) => o.value === value);
  const display = selected ? selected.label : placeholder;

  const dropdown = open && createPortal(
    <div
      ref={dropdownRef}
      className="fixed z-[9999] rounded-lg border border-border bg-popover shadow-xl max-h-56 overflow-auto"
      style={dropdownStyle}
      role="listbox"
    >
      {options.map((opt, i) => {
        // Headers are presentational so they stay out of the option sequence
        // for assistive tech and for tests that select by role="option".
        const header =
          opt.group && opt.group !== options[i - 1]?.group ? (
            <div
              key={`group-${opt.group}`}
              role="presentation"
              className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {opt.group}
            </div>
          ) : null;

        return (
          <div key={opt.value}>
            {header}
            <button
              type="button"
              role="option"
              aria-selected={opt.value === value}
              onClick={() => {
                onChange?.(opt.value);
                setOpen(false);
              }}
              className={`w-full px-3 py-2 text-left text-sm transition-colors flex items-center justify-between gap-2 ${
                opt.value === value
                  ? "bg-primary/20 text-primary"
                  : "text-foreground hover:bg-muted/50"
              }`}
            >
              <span className="truncate">{opt.label}</span>
              {opt.detail && (
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {opt.detail}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>,
    document.body
  );

  return (
    <div ref={containerRef} className={`relative ${className}`} data-testid={testId}>
      {label && (
        <Label>
          <span className="inline-flex items-center gap-1">
            {label}
            {tooltip && <InfoTooltip text={tooltip} />}
          </span>
        </Label>
      )}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={openDropdown}
        className="w-full rounded-lg bg-popover border border-border px-3 py-2 text-sm text-foreground text-left outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/25 transition-colors flex items-center justify-between disabled:opacity-50"
      >
        <span className={value ? "" : "text-muted-foreground"}>{display}</span>
        <span className="text-muted-foreground ml-1">{open ? "▲" : "▼"}</span>
      </button>
      {dropdown}
      {hint && <p className="mt-1 text-xs text-blue-500">{hint}</p>}
    </div>
  );
}
