'use client';

import { imageAt } from '@clowe/shared';

/**
 * Where the picture must never be cropped: click the spot (a face, the
 * products) and it stays in view at every width, on computers and phones.
 * Stored as percent across and percent down; 50/50 is the centre.
 */
export default function FocalPointPicker({
  imageUrl,
  mobileImageUrl,
  x,
  y,
  onChange,
}: {
  imageUrl: string;
  mobileImageUrl?: string;
  x: number;
  y: number;
  onChange: (x: number, y: number) => void;
}) {
  const pictures = [imageUrl, mobileImageUrl].filter((u): u is string => !!u && u.trim().length > 0);
  if (pictures.length === 0) return null;
  const pick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = Math.round(((e.clientX - r.left) / r.width) * 100);
    const py = Math.round(((e.clientY - r.top) / r.height) * 100);
    onChange(Math.min(100, Math.max(0, px)), Math.min(100, Math.max(0, py)));
  };
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3" data-focal-picker>
      <p className="text-xs font-semibold text-ink-900">Keep in view — click the face or products that must never be cut off</p>
      <p className="text-[11px] text-gray-500">
        Focal point: {x}% across, {y}% down. The picture is cropped around this point at every screen width.{' '}
        <button type="button" onClick={() => onChange(50, 50)} className="font-semibold text-brand-600 hover:underline">
          Reset to centre
        </button>
      </p>
      <div className="mt-2 flex flex-wrap items-start gap-3">
        {pictures.map((url, i) => (
          <button
            key={url}
            type="button"
            onClick={pick}
            className={`relative block overflow-hidden rounded-lg border border-gray-200 ${i === 0 ? 'w-full max-w-md' : 'w-28'}`}
            aria-label={`Set the focal point on the ${i === 0 ? 'computer' : 'phone'} picture`}
            data-focal-target={i === 0 ? 'computer' : 'phone'}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageAt(url, 800)} alt="" className="block h-auto w-full" draggable={false} />
            <span
              aria-hidden
              className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand-600/70 shadow-[0_0_0_2px_rgba(0,0,0,0.35)]"
              style={{ left: `${x}%`, top: `${y}%` }}
            />
            <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-px text-[10px] font-semibold text-white">{i === 0 ? 'Computer' : 'Phone'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
