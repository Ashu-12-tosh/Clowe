import { code128Widths } from '@clowe/shared';

/**
 * A scannable Code 128 barcode, sized in millimetres so it prints true:
 * Delhivery's scanners want bars at least 8 mm tall and no thinner than
 * 8 mil (0.2 mm). Quiet zones of ten modules either side are left blank.
 */
export function Code128({
  value,
  heightMm = 12,
  moduleMm = 0.33,
  className,
}: {
  value: string;
  heightMm?: number;
  /** One module (the thinnest bar); keep it at 0.25 mm or more. */
  moduleMm?: number;
  className?: string;
}) {
  const widths = code128Widths(value);
  const quiet = 10;
  const total = widths.reduce((a, b) => a + b, 0) + quiet * 2;
  let x = quiet;
  const bars: { x: number; w: number }[] = [];
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, w });
    x += w;
  });
  return (
    <svg
      role="img"
      aria-label={`Barcode ${value}`}
      viewBox={`0 0 ${total} 1`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      style={{ width: `${total * moduleMm}mm`, height: `${heightMm}mm` }}
      className={className}
      data-barcode={value}
    >
      <rect x={0} y={0} width={total} height={1} fill="#fff" />
      {bars.map((b) => (
        <rect key={b.x} x={b.x} y={0} width={b.w} height={1} fill="#000" />
      ))}
    </svg>
  );
}
