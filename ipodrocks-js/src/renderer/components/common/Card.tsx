import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
  action?: ReactNode;
}

const cardBase =
  "bg-[#131626] rounded-xl border border-white/[0.06] p-5 " +
  "[.theme-light_&]:bg-white [.theme-light_&]:border-[#dadce0]";
const titleClass =
  "text-sm font-semibold text-white [.theme-light_&]:text-[#202124]";
const subtitleClass =
  "text-xs text-[#5a5f68] mt-0.5 [.theme-light_&]:text-[#5f6368]";

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
