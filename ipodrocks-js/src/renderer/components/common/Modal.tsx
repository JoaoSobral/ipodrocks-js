import type { ReactNode } from "react";
import { useEffect } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
  /** When true, clicking the backdrop calls onClose. Default false (forms stay open). */
  closeOnBackdropClick?: boolean;
  /** When true, modal is ~15% wider (e.g. for multi-step forms). */
  wide?: boolean;
  /** Override the max-width class entirely (e.g. "max-w-4xl"). */
  width?: string;
  /** Icon for the top-right close button. Default "✕". Use "−" for minimize/background. */
  closeIcon?: string;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  className = "",
  closeOnBackdropClick = false,
  wide = false,
  width,
  closeIcon = "✕",
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleBackdropClick = closeOnBackdropClick ? onClose : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleBackdropClick}
        aria-hidden
      />
      <div
        className={`relative bg-card rounded-2xl border border-border shadow-2xl w-full mx-4 ${width ?? (wide ? "max-w-[37rem]" : "max-w-lg")} ${className}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h3 className="text-base font-semibold text-card-foreground">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors text-lg leading-none w-8 h-8 flex items-center justify-center"
            title={closeIcon === "−" ? "Minimize (build continues in background)" : "Close"}
          >
            {closeIcon}
          </button>
        </div>
        <div className="p-6 text-card-foreground overflow-y-auto max-h-[80vh]">{children}</div>
      </div>
    </div>
  );
}
