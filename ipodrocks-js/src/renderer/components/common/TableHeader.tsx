import type { ReactNode } from "react";

interface TableHeaderProps {
  children: ReactNode;
  sticky?: boolean;
  className?: string;
}

export function TableHeader({
  children,
  sticky = false,
  className = "",
}: TableHeaderProps) {
  const baseClass =
    "flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border bg-card";
  const stickyClass = sticky ? "sticky top-0 z-10" : "";
  return (
    <div className={`${baseClass} ${stickyClass} ${className}`}>{children}</div>
  );
}
