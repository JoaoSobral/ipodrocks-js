import { useRef, useEffect, useState } from "react";

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
  options,
  value = "",
  onChange,
  placeholder = "Select…",
  className = "",
  disabled = false,
}: SelectProps) {
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
      {label && (
        <label className="block text-xs font-medium text-[#8a8f98] mb-1.5">{label}</label>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className="w-full rounded-lg bg-[#131626] border border-white/[0.08] px-3 py-2 text-sm text-[#e0e0e0] text-left outline-none focus:border-[#4a9eff]/50 focus:ring-1 focus:ring-[#4a9eff]/25 transition-colors flex items-center justify-between disabled:opacity-50 [.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0] [.theme-light_&]:text-[#1a1a1a]"
      >
        <span
          className={
            value
              ? "[.theme-light_&]:text-[#1a1a1a]"
              : "text-[#5a5f68] [.theme-light_&]:text-[#6b7280]"
          }
        >
          {display}
        </span>
        <span className="text-[#5a5f68] ml-1 [.theme-light_&]:text-[#6b7280]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          className="absolute z-50 mt-1 w-full rounded-lg border border-white/[0.08] bg-[#131626] shadow-xl max-h-56 overflow-auto [.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0]"
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
                  ? "bg-[#4a9eff]/20 text-[#4a9eff]"
                  : "text-[#e0e0e0] hover:bg-white/[0.06] [.theme-light_&]:text-[#1a1a1a] [.theme-light_&]:hover:bg-[#f3f4f6]"
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
