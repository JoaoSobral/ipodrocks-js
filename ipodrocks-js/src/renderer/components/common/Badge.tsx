import type { ReactNode } from "react";

type BadgeVariant = "primary" | "success" | "destructive" | "warning" | "muted";

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  destructive: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  muted: "bg-muted text-muted-foreground",
};

export function Badge({
  children,
  variant = "primary",
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
