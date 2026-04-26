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
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-muted-foreground/50 text-muted-foreground hover:border-primary hover:text-primary transition-colors text-[9px] font-bold leading-none cursor-default"
      >
        i
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
