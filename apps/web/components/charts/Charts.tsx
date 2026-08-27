'use client';

/**
 * Dependency-free SVG charts for the AI Try-On Monitor. They stay deliberately
 * small: a donut, a line/area chart and a bar list cover every panel.
 */

/** Categorical palette — gold-led, readable side by side on white. */
export const CHART_COLORS = [
  '#B8860B', // gold
  '#141414', // ink
  '#3B82F6', // blue
  '#10B981', // green
  '#F59E0B', // amber
  '#8B5CF6', // violet
  '#EF4444', // red
  '#64748B', // slate
];

export function colorAt(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

export interface Slice {
  key: string;
  label: string;
  count: number;
  share: number;
}

/** Donut with a centred total and a legend beside it. */
export function DonutChart({
  slices,
  total,
  totalLabel,
  size = 148,
}: {
  slices: Slice[];
  total: number;
  totalLabel: string;
  size?: number;
}) {
  const stroke = 22;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#F1EFEA"
            strokeWidth={stroke}
          />
          {slices.map((s, i) => {
            const length = (s.share / 100) * circumference;
            const dash = `${length} ${circumference - length}`;
            const el = (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={colorAt(i)}
                strokeWidth={stroke}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
              >
                <title>{`${s.label}: ${s.count.toLocaleString('en-IN')} (${s.share}%)`}</title>
              </circle>
            );
            offset += length;
            return el;
          })}
        </g>
        <text
          x="50%"
          y="47%"
          textAnchor="middle"
          className="fill-ink-900 text-lg font-bold"
          style={{ fontSize: 18, fontWeight: 700 }}
        >
          {total.toLocaleString('en-IN')}
        </text>
        <text
          x="50%"
          y="60%"
          textAnchor="middle"
          style={{ fontSize: 9, fill: '#9CA3AF', letterSpacing: 0.4 }}
        >
          {totalLabel}
        </text>
      </svg>

      <ul className="min-w-40 flex-1 space-y-1.5">
        {slices.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2 text-xs">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: colorAt(i) }}
            />
            <span className="flex-1 truncate text-gray-600">{s.label}</span>
            <span className="font-semibold text-ink-900">{s.share}%</span>
            <span className="w-14 text-right text-gray-400">
              ({s.count.toLocaleString('en-IN')})
            </span>
          </li>
        ))}
        {slices.length === 0 && <li className="text-xs text-gray-400">No data in this range</li>}
      </ul>
    </div>
  );
}

export interface LinePoint {
  date: string;
  value: number;
}

/**
 * Area + line chart over a daily series. `format` renders the tooltip/axis
 * value (e.g. seconds instead of a raw count).
 */
export function LineChart({
  points,
  color = '#B8860B',
  height = 170,
  format = (v: number) => v.toLocaleString('en-IN'),
}: {
  points: LinePoint[];
  color?: string;
  height?: number;
  format?: (value: number) => string;
}) {
  const width = 560;
  const padLeft = 38;
  const padBottom = 22;
  const padTop = 10;

  if (points.length === 0) {
    return <p className="py-8 text-center text-xs text-gray-400">No data in this range</p>;
  }

  const max = Math.max(1, ...points.map((p) => p.value));
  const innerW = width - padLeft - 8;
  const innerH = height - padTop - padBottom;
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;

  const x = (i: number) => padLeft + i * stepX;
  const y = (v: number) => padTop + innerH - (v / max) * innerH;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join(' ');
  const area = `${line} L${x(points.length - 1)},${padTop + innerH} L${padLeft},${
    padTop + innerH
  } Z`;

  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
      {gridValues.map((v) => (
        <g key={v}>
          <line x1={padLeft} x2={width - 8} y1={y(v)} y2={y(v)} stroke="#F1EFEA" strokeWidth={1} />
          <text x={padLeft - 6} y={y(v) + 3} textAnchor="end" style={{ fontSize: 9, fill: '#9CA3AF' }}>
            {format(Math.round(v))}
          </text>
        </g>
      ))}

      <path d={area} fill={color} opacity={0.1} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />

      {points.map((p, i) => (
        <g key={p.date}>
          <circle cx={x(i)} cy={y(p.value)} r={points.length > 40 ? 1.6 : 2.6} fill={color}>
            <title>{`${p.date}: ${format(p.value)}`}</title>
          </circle>
          {i % labelEvery === 0 && (
            <text
              x={x(i)}
              y={height - 6}
              textAnchor="middle"
              style={{ fontSize: 9, fill: '#9CA3AF' }}
            >
              {p.date.slice(5).replace('-', '/')}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

export interface Series {
  key: string;
  label: string;
  color: string;
  points: LinePoint[];
  /** Dashed stroke — used for secondary series like fees. */
  dashed?: boolean;
  /** Fill the area under the line. */
  fill?: boolean;
}

/** Several series on one set of axes, with a legend (earnings trend). */
export function MultiLineChart({
  series,
  height = 200,
  format = (v: number) => v.toLocaleString('en-IN'),
}: {
  series: Series[];
  height?: number;
  format?: (value: number) => string;
}) {
  const width = 620;
  const padLeft = 52;
  const padBottom = 22;
  const padTop = 10;

  const length = Math.max(...series.map((s) => s.points.length), 0);
  if (length === 0) {
    return <p className="py-10 text-center text-xs text-gray-400">No data in this period</p>;
  }

  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.value)));
  const innerW = width - padLeft - 8;
  const innerH = height - padTop - padBottom;
  const stepX = length > 1 ? innerW / (length - 1) : 0;
  const x = (i: number) => padLeft + i * stepX;
  const y = (v: number) => padTop + innerH - (v / max) * innerH;

  const labels = series[0]?.points.map((p) => p.date) ?? [];
  const labelEvery = Math.max(1, Math.ceil(length / 6));

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-gray-600">
            <svg width="18" height="8">
              <line
                x1="0"
                y1="4"
                x2="18"
                y2="4"
                stroke={s.color}
                strokeWidth="2"
                strokeDasharray={s.dashed ? '3 2' : undefined}
              />
            </svg>
            {s.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line
              x1={padLeft}
              x2={width - 8}
              y1={y(max * f)}
              y2={y(max * f)}
              stroke="#F1EFEA"
              strokeWidth={1}
            />
            <text
              x={padLeft - 6}
              y={y(max * f) + 3}
              textAnchor="end"
              style={{ fontSize: 9, fill: '#9CA3AF' }}
            >
              {format(Math.round(max * f))}
            </text>
          </g>
        ))}

        {series.map((s) => {
          const path = s.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`)
            .join(' ');
          return (
            <g key={s.key}>
              {s.fill && s.points.length > 1 && (
                <path
                  d={`${path} L${x(s.points.length - 1)},${padTop + innerH} L${padLeft},${padTop + innerH} Z`}
                  fill={s.color}
                  opacity={0.08}
                />
              )}
              <path
                d={path}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeDasharray={s.dashed ? '4 3' : undefined}
              />
              {s.points.map((p, i) => (
                <circle key={p.date} cx={x(i)} cy={y(p.value)} r={length > 20 ? 1.6 : 2.6} fill={s.color}>
                  <title>{`${p.date} · ${s.label}: ${format(p.value)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}

        {labels.map((date, i) =>
          i % labelEvery === 0 ? (
            <text
              key={date}
              x={x(i)}
              y={height - 6}
              textAnchor="middle"
              style={{ fontSize: 9, fill: '#9CA3AF' }}
            >
              {date.slice(5).replace('-', '/')}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

export interface BarItem {
  key: string;
  label: string;
  /** Bar fill, 0–100. */
  percent: number;
  /** Right-hand figure. */
  value: string;
  hint?: string;
}

/** Ranked horizontal bars — categories, model performance, quality signals. */
export function BarList({
  items,
  color = '#B8860B',
  numbered = false,
}: {
  items: BarItem[];
  color?: string;
  numbered?: boolean;
}) {
  if (items.length === 0) {
    return <p className="py-6 text-center text-xs text-gray-400">No data in this range</p>;
  }
  return (
    <ul className="space-y-2.5">
      {items.map((item, i) => (
        <li key={item.key} className="text-xs">
          <div className="flex items-center gap-2">
            {numbered && <span className="w-4 text-gray-400">{i + 1}.</span>}
            <span className="min-w-0 flex-1 truncate font-medium text-gray-700">{item.label}</span>
            <span className="whitespace-nowrap font-semibold text-ink-900">{item.value}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            {numbered && <span className="w-4" />}
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-cream-100">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, Math.max(item.percent, item.percent > 0 ? 2 : 0))}%`,
                  backgroundColor: color,
                }}
              />
            </div>
          </div>
          {item.hint && (
            <p className={`mt-0.5 text-[11px] text-gray-400 ${numbered ? 'pl-6' : ''}`}>
              {item.hint}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
