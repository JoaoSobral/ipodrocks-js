import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
  action?: ReactNode;
}

const cardBase = "bg-card rounded-xl border border-border p-5";
const titleClass = "text-sm font-semibold text-card-foreground";
const subtitleClass = "text-xs text-muted-foreground mt-0.5";

export function Card({ children, className = "", title, subtitle, action }: CardProps) {
  return (
    <div className={`${cardBase} ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between mb-4">
          <div>
            {title && <h3 className={titleClass}>{title}</h3>}
            {subtitle && <p className={subtitleClass}>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
