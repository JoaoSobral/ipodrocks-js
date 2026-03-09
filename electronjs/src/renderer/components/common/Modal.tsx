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
        className={`relative bg-[#131626] rounded-2xl border border-white/[0.08] shadow-2xl w-full mx-4 [.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0] ${wide ? "max-w-[37rem]" : "max-w-lg"} ${className}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] [.theme-light_&]:border-[#e2e8f0]">
          <h3 className="text-base font-semibold text-white [.theme-light_&]:text-[#1a1a1a]">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[#5a5f68] hover:text-white transition-colors text-lg leading-none w-8 h-8 flex items-center justify-center [.theme-light_&]:text-[#6b7280] [.theme-light_&]:hover:text-[#1a1a1a]"
            title={closeIcon === "−" ? "Minimize (build continues in background)" : "Close"}
          >
            {closeIcon}
          </button>
        </div>
        <div className="p-6 [.theme-light_&]:text-[#1a1a1a]">{children}</div>
      </div>
    </div>
  );
}
