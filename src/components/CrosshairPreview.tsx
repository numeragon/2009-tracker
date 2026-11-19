import type { CrosshairLines, CrosshairVisual } from "../lib/crosshair";

interface CrosshairPreviewProps {
  visual: CrosshairVisual;
  className?: string;
}

const VIEW = 160;
const CENTER = VIEW / 2;
const SCALE = 3;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function lineRects(lines: CrosshairLines): Rect[] {
  const thickness = Math.max(lines.thickness * SCALE, 1.5);
  const offset = Math.max(lines.offset * SCALE, 0);
  const horizontal = Math.max(lines.length * SCALE, 0);
  const vertical = Math.max((lines.linked ? lines.length : lines.vertical) * SCALE, 0);

  return [
    // top / bottom use the vertical length
    { x: CENTER - thickness / 2, y: CENTER - offset - vertical, w: thickness, h: vertical },
    { x: CENTER - thickness / 2, y: CENTER + offset, w: thickness, h: vertical },
    // left / right use the horizontal length
    { x: CENTER - offset - horizontal, y: CENTER - thickness / 2, w: horizontal, h: thickness },
    { x: CENTER + offset, y: CENTER - thickness / 2, w: horizontal, h: thickness },
  ];
}

export function CrosshairPreview({ visual, className = "" }: CrosshairPreviewProps) {
  const pad = visual.outline.show ? Math.max(visual.outline.thickness * SCALE, 1) : 0;

  const renderLines = (lines: CrosshairLines, keyPrefix: string) => {
    if (!lines.show) return null;
    const opacity = Math.max(0, Math.min(1, lines.opacity));
    return (
      <g key={keyPrefix}>
        {lineRects(lines).map((rect, index) =>
          pad > 0 ? (
            <rect
              key={`${keyPrefix}-outline-${index}`}
              x={rect.x - pad}
              y={rect.y - pad}
              width={rect.w + pad * 2}
              height={rect.h + pad * 2}
              fill={visual.outline.color}
              fillOpacity={visual.outline.opacity}
            />
          ) : null,
        )}
        {lineRects(lines).map((rect, index) => (
          <rect
            key={`${keyPrefix}-line-${index}`}
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill={visual.color}
            fillOpacity={opacity}
          />
        ))}
      </g>
    );
  };

  const dotSize = Math.max(visual.centerDot.size * SCALE, 2);

  return (
    <svg
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      className={className}
      role="img"
      aria-label="クロスヘアプレビュー"
      shapeRendering="crispEdges"
    >
      <defs>
        <radialGradient id="crosshair-bg-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.045" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width={VIEW} height={VIEW} fill="url(#crosshair-bg-glow)" />
      <line
        x1={CENTER - 56}
        y1={CENTER}
        x2={CENTER + 56}
        y2={CENTER}
        stroke="#ffffff"
        strokeOpacity="0.04"
      />
      <line
        x1={CENTER}
        y1={CENTER - 56}
        x2={CENTER}
        y2={CENTER + 56}
        stroke="#ffffff"
        strokeOpacity="0.04"
      />
      {renderLines(visual.outer, "outer")}
      {renderLines(visual.inner, "inner")}
      {visual.centerDot.show && (
        <rect
          x={CENTER - dotSize / 2}
          y={CENTER - dotSize / 2}
          width={dotSize}
          height={dotSize}
          fill={pad > 0 ? visual.outline.color : visual.color}
          fillOpacity={pad > 0 ? visual.outline.opacity : 1}
        />
      )}
      {visual.centerDot.show && (
        <rect
          x={CENTER - dotSize / 2}
          y={CENTER - dotSize / 2}
          width={dotSize}
          height={dotSize}
          fill={visual.color}
          fillOpacity={Math.max(0, Math.min(1, visual.centerDot.opacity))}
        />
      )}
    </svg>
  );
}
