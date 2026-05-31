import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  // Text to show on hover / focus. Required — empty labels short-circuit
  // (the children render bare, no wrapper) so they don't add layout.
  label: string;
  children: ReactNode;
  // Preferred side. The component auto-flips if there isn't room.
  position?: 'top' | 'bottom';
}

// Custom hover tooltip. Charcoal pill (not pure black), soft shadow, calm
// fade in. Rendered through a portal at the document root so it can sit
// over anything — and so its position can be computed from the trigger's
// viewport rect rather than being constrained by ancestor overflow. The
// horizontal position auto-clamps to the viewport so buttons near the
// left or right edge no longer get their tooltip clipped; the vertical
// side auto-flips to 'bottom' when the trigger is too close to the top.
export function Tooltip({ label, children, position = 'top' }: TooltipProps) {
  const [shown, setShown] = useState(false);
  // null while not yet measured; the tooltip stays render-hidden so the
  // first frame doesn't flash at the wrong coordinates.
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);

  // Measure on every show so the position is always current. Uses
  // layout-effect so the placement is computed before paint, avoiding a
  // visible jump from a default position to the corrected one.
  useLayoutEffect(() => {
    if (!shown) {
      setCoords(null);
      return;
    }
    const wrap = wrapperRef.current;
    const tip = tooltipRef.current;
    if (!wrap || !tip) return;

    const triggerRect = wrap.getBoundingClientRect();
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const margin = 8; // gap from viewport edges
    const gap = 6; // gap between tooltip and trigger
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: try to centre on the trigger, then clamp to viewport.
    let left = triggerRect.left + triggerRect.width / 2 - tipW / 2;
    left = Math.max(margin, Math.min(left, vw - tipW - margin));

    // Vertical: prefer the requested side; flip if there's no room.
    const topRoom = triggerRect.top - tipH - gap;
    const bottomRoom = vh - (triggerRect.bottom + tipH + gap);
    let top: number;
    if (position === 'top') {
      top = topRoom >= margin
        ? triggerRect.top - tipH - gap
        : triggerRect.bottom + gap;
    } else {
      top = bottomRoom >= margin
        ? triggerRect.bottom + gap
        : triggerRect.top - tipH - gap;
    }

    setCoords({ top, left });
  }, [shown, position, label]);

  if (!label) return <>{children}</>;

  const handleShow = () => setShown(true);
  const handleHide = () => setShown(false);

  return (
    <>
      <span
        ref={wrapperRef}
        className="inline-flex"
        onMouseEnter={handleShow}
        onMouseLeave={handleHide}
        onFocus={handleShow}
        onBlur={handleHide}
      >
        {children}
      </span>
      {shown &&
        createPortal(
          <span
            ref={tooltipRef}
            role="tooltip"
            className="pointer-events-none fixed z-[100] whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium leading-none text-white transition-opacity duration-100"
            style={{
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              // Hidden until the layout-effect has measured & placed.
              opacity: coords ? 1 : 0,
              background: '#1F2024',
              boxShadow:
                '0 1px 0 rgba(255,255,255,0.06) inset, 0 6px 18px -6px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(0,0,0,0.4)',
            }}
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}
