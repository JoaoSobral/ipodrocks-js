import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary: "bg-[#4a9eff] text-white hover:bg-[#3a8eef] active:bg-[#2a7edf]",
  secondary: "bg-white/[0.06] text-[#e0e0e0] hover:bg-white/10 border border-white/[0.08]",
  danger: "bg-[#ef4444]/10 text-[#ef4444] hover:bg-[#ef4444]/20 border border-[#ef4444]/20",
  ghost: "text-[#8a8f98] hover:text-[#e0e0e0] hover:bg-white/5",
};

const sizes: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors cursor-default disabled:opacity-40 disabled:pointer-events-none ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
