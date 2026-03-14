import type { ReactNode } from "react";

interface LabelProps {
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}

export function Label({ children, htmlFor, className = "" }: LabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      className={`block text-xs font-medium text-muted-foreground mb-1.5 ${className}`}
    >
      {children}
    </label>
  );
}
