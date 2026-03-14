import type { ReactNode } from "react";

interface ErrorBoxProps {
  children: ReactNode;
  className?: string;
}

export function ErrorBox({ children, className = "" }: ErrorBoxProps) {
  return (
    <div
      className={`rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive ${className}`}
    >
      {children}
    </div>
  );
}
