import type { InputHTMLAttributes } from "react";
import { Label } from "./Label";
import { InfoTooltip } from "./InfoTooltip";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  tooltip?: string;
  error?: string;
}

export function Input({ label, tooltip, error, className = "", id, ...props }: InputProps) {
  const inputId = id ?? (label ? `input-${label.replace(/\s/g, "-").toLowerCase()}` : undefined);
  return (
    <div className={className}>
      {label && (
        <Label htmlFor={inputId}>
          <span className="inline-flex items-center gap-1">
            {label}
            {tooltip && <InfoTooltip text={tooltip} />}
          </span>
        </Label>
      )}
      <input
        id={inputId}
        className={`w-full rounded-lg bg-input border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 transition-colors ${error ? "border-destructive focus:border-destructive focus:ring-destructive/25" : "border-border focus:border-primary/50 focus:ring-primary/25"}`}
        {...props}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
