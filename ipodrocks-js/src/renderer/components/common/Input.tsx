import type { InputHTMLAttributes } from "react";
import { Label } from "./Label";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Input({ label, className = "", id, ...props }: InputProps) {
  const inputId = id ?? (label ? `input-${label.replace(/\s/g, "-").toLowerCase()}` : undefined);
  return (
    <div className={className}>
      {label && <Label htmlFor={inputId}>{label}</Label>}
      <input
        id={inputId}
        className="w-full rounded-lg bg-input border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/25 transition-colors"
        {...props}
      />
    </div>
  );
}
