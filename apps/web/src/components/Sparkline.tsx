interface Props {
  points: [number, number][];
  width?: number;
  height?: number;
  label?: string;
}

export function Sparkline({ points, width = 320, height = 56, label }: Props) {
  if (points.length < 2) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const pad = 4;
  const sx = (x: number) => pad + ((x - x0) / (x1 - x0 || 1)) * (width - pad * 2);
  const sy = (y: number) => height - pad - ((y - y0) / (y1 - y0 || 1)) * (height - pad * 2);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ");
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label ?? `${y0.toFixed(0)}–${y1.toFixed(0)}°C`}
    >
      <path d={d} fill="none" stroke="var(--color-primary)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
