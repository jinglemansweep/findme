import { useEffect, useId, useRef, useState } from "react";
import { InfoIcon } from "./icons";

/**
 * Hover/focus/click tooltip for short advisory text. Click support keeps it
 * reachable on touch screens, where there is no hover. `align` picks which
 * way the popover opens from the icon: "right" anchors it at the icon's
 * right edge, "left" lets it grow rightward from the icon's left. `above`
 * flips it above the icon for rows near the bottom of a scrollable card,
 * where opening downward would grow the scroll area.
 */
export function InfoTooltip({
  text,
  label = "More information",
  align = "right",
  above = false,
}: {
  text: string;
  label?: string;
  align?: "right" | "left";
  above?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Dismiss on outside press or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span
      ref={ref}
      className={`info-tip${align === "left" ? " pop-left" : ""}${above ? " pop-above" : ""}${open ? " open" : ""}`}
    >
      <button
        type="button"
        className="button ghost icon-button info-tip-button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => setOpen((v) => !v)}
      >
        <InfoIcon />
      </button>
      <span className="info-tip-pop" id={id} role="tooltip">
        {text}
      </span>
    </span>
  );
}
