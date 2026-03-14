interface ProgressBarProps {
  value: number;
  color?: string;
  className?: string;
  showLabel?: boolean;
}

export function ProgressBar({
  value,
  color,
  className = "",
  showLabel = false,
}: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${!color ? "bg-primary" : ""}`}
          style={{ width: `${clamped}%`, ...(color ? { backgroundColor: color } : {}) }}
        />
      </div>
      {showLabel && (
        <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
          {Math.round(clamped)}%
        </span>
      )}
    </div>
  );
}
