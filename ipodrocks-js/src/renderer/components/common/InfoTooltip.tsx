import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

interface InfoTooltipProps {
  text: string;
}

export function InfoTooltip({ text }: InfoTooltipProps) {
  const [visible, setVisible] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);

  function position() {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setStyle({ top: r.bottom + 6, left: r.left + r.width / 2 });
  }

  useEffect(() => {
    if (!visible) return;
    const hide = () => setVisible(false);
    document.addEventListener("mousedown", hide);
    return () => document.removeEventListener("mousedown", hide);
  }, [visible]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="More info"
        onMouseEnter={() => { position(); setVisible(true); }}
        onMouseLeave={() => setVisible(false)}
        onClick={(e) => { e.stopPropagation(); position(); setVisible((v) => !v); }}
        className="inline-flex items-center justify-center w-4 h-4 text-muted-foreground/60 hover:text-primary transition-colors cursor-default"
      >
        <svg viewBox="0 0 24 24" className="w-full h-full" fill="currentColor" aria-hidden="true">
          <path d="M12 22c5.5 0 10-4.5 10-10S17.5 2 12 2S2 6.5 2 12s4.5 10 10 10M11 7h2v2h-2zm3 10h-4v-2h1v-2h-1v-2h3v4h1z" />
        </svg>
      </button>
      {visible && createPortal(
        <div
          className="fixed z-[9999] max-w-[220px] rounded-lg border border-border bg-popover shadow-xl px-3 py-2 text-xs text-foreground pointer-events-none -translate-x-1/2"
          style={style}
        >
          {text}
          <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-2.5 h-2.5 rotate-45 border-l border-t border-border bg-popover" />
        </div>,
        document.body
      )}
    </>
  );
}
