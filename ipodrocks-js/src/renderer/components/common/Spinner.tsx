interface SpinnerProps {
  size?: "sm" | "md";
  className?: string;
}

export function Spinner({ size = "sm", className = "" }: SpinnerProps) {
  const sizeClass = size === "sm" ? "w-5 h-5" : "w-6 h-6";
  return (
    <div
      className={`${sizeClass} border-2 border-primary/30 border-t-primary rounded-full animate-spin ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}
