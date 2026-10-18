import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface TooltipPlacement {
  readonly left: number;
  readonly top: number;
  /** Placed left of the anchor because the right side had no room. */
  readonly flippedX: boolean;
  /** Placed above the anchor because the bottom had no room. */
  readonly flippedY: boolean;
}

/**
 * Where a tooltip of `size` goes next to `anchor` inside `container`: right
 * of and below the anchor, flipped to the other side near an edge and
 * clamped so it never leaves the container.
 */
export function placeTooltip(anchor: Point, size: Size, container: Size, offset = 10): TooltipPlacement {
  let left = anchor.x + offset;
  let flippedX = false;
  if (left + size.width > container.width) {
    left = anchor.x - offset - size.width;
    flippedX = true;
  }
  let top = anchor.y + offset;
  let flippedY = false;
  if (top + size.height > container.height) {
    top = anchor.y - offset - size.height;
    flippedY = true;
  }
  return {
    left: Math.max(0, Math.min(left, container.width - size.width)),
    top: Math.max(0, Math.min(top, container.height - size.height)),
    flippedX,
    flippedY,
  };
}

export interface TooltipRow {
  readonly label: string;
  readonly value: string;
}

export interface TooltipProps {
  /** Anchor point in the coordinates of the tooltip's offset parent (a positioned container). */
  anchor: Point;
  /** Muted first line, e.g. the category or bin edges. */
  title?: string;
  /** Exact values from the aggregate rows: grouped digits, full precision. */
  rows?: readonly TooltipRow[];
  children?: ReactNode;
  id?: string;
}

/**
 * Chart tooltip. Sits inside a positioned container and flips to stay inside
 * it near the edges.
 */
export function Tooltip({ anchor, title, rows = [], children, id }: TooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const container = element.offsetParent as HTMLElement | null;
    // Without a laid-out container (detached, or no layout engine) keep the default side.
    const bounds = container ? { width: container.clientWidth, height: container.clientHeight } : { width: Infinity, height: Infinity };
    setPlacement(placeTooltip(anchor, { width: element.offsetWidth, height: element.offsetHeight }, bounds));
  }, [anchor, title, rows, children]);

  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="gg-tooltip"
      data-flipped-x={placement?.flippedX ?? false}
      data-flipped-y={placement?.flippedY ?? false}
      style={placement ? { left: placement.left, top: placement.top } : { left: anchor.x, top: anchor.y, visibility: 'hidden' }}
    >
      {title !== undefined && <span className="gg-tooltip__title">{title}</span>}
      {rows.map((row) => (
        <div className="gg-tooltip__row" key={row.label}>
          <span className="gg-tooltip__label">{row.label}</span>
          <span className="gg-tooltip__value">{row.value}</span>
        </div>
      ))}
      {children}
    </div>
  );
}
