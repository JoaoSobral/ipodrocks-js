import { useRef, useEffect, useState } from "react";
import { Label } from "./Label";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  label?: string;
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function Select({
  label,
  options: optionsProp,
  value = "",
  onChange,
  placeholder = "Select…",
  className = "",
  disabled = false,
}: SelectProps) {
  const options = Array.isArray(optionsProp) ? optionsProp : [];
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const display = selected ? selected.label : placeholder;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {label && <Label>{label}</Label>}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className="w-full rounded-lg bg-popover border border-border px-3 py-2 text-sm text-foreground text-left outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/25 transition-colors flex items-center justify-between disabled:opacity-50"
      >
        <span className={value ? "" : "text-muted-foreground"}>{display}</span>
        <span className="text-muted-foreground ml-1">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-popover shadow-xl max-h-56 overflow-auto"
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
        </div>
      )}
    </div>
  );
}
