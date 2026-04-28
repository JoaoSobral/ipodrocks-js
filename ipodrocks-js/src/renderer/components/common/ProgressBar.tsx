interface ProgressBarProps {
  value: number;
  color?: string;
  className?: string;
  showLabel?: boolean;
  showPercent?: boolean;
  variant?: "default" | "success" | "error";
}

const VARIANT_COLORS: Record<"default" | "success" | "error", string> = {
  success: "bg-green-500",
  error: "bg-destructive",
  default: "bg-primary",
};

export function ProgressBar({
  value,
  color,
  className = "",
  showLabel = false,
  showPercent = false,
  variant = "default",
}: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value));
  const barColor = color ? undefined : VARIANT_COLORS[variant];
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor ?? ""}`}
          style={{ width: `${clamped}%`, ...(color ? { backgroundColor: color } : {}) }}
        />
      </div>
      {(showLabel || showPercent) && (
        <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
          {Math.round(clamped)}%
        </span>
      )}
    </div>
  );
}
