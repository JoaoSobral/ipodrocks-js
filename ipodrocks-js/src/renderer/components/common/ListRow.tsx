import type { ReactNode } from "react";

interface ListRowProps {
  children: ReactNode;
  className?: string;
  as?: "div" | "button";
  onClick?: () => void;
}

export function ListRow({
  children,
  className = "",
  as: Component = "div",
  onClick,
}: ListRowProps) {
  const baseClass =
    "flex items-center gap-3 p-2.5 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors";
  return (
    <Component
      className={`${baseClass} ${className}`}
      onClick={onClick}
      type={Component === "button" ? "button" : undefined}
    >
      {children}
    </Component>
  );
}
