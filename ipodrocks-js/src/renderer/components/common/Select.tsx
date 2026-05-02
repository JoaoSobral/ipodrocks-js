import { useRef, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Label } from "./Label";
import { InfoTooltip } from "./InfoTooltip";

interface SelectOption {
  value: string;
  label: string;
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
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropdownMaxH = 224; // max-h-56 = 14rem = 224px
      if (spaceBelow >= dropdownMaxH || spaceBelow >= 120) {
        setDropdownStyle({ top: rect.bottom + 4, left: rect.left, width: rect.width });
      } else {
        setDropdownStyle({ bottom: window.innerHeight - rect.top + 4, left: rect.left, width: rect.width });
      }
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
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="option"
          aria-selected={opt.value === value}
          onClick={() => {
            onChange?.(opt.value);
            setOpen(false);
          }}
          className={`w-full px-3 py-2 text-left text-sm transition-colors ${
            opt.value === value
              ? "bg-primary/20 text-primary"
              : "text-foreground hover:bg-muted/50"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>,
    document.body
  );

  return (
    <div ref={containerRef} className={`relative ${className}`}>
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
