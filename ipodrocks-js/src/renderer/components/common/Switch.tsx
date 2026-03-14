import type { ButtonHTMLAttributes } from "react";

interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onChange?: (checked: boolean) => void;
}

export function Switch({
  checked,
  onChange,
  className = "",
  disabled,
  ...props
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-primary" : "bg-muted"
      } ${className}`}
      {...props}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-primary-foreground shadow ring-0 transition ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
