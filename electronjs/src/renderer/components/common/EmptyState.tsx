import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon = "∅", title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span className="text-4xl text-[#5a5f68]/50 mb-4">{icon}</span>
      <h3 className="text-sm font-medium text-[#8a8f98] mb-1">{title}</h3>
      {description && <p className="text-xs text-[#5a5f68] max-w-xs">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
