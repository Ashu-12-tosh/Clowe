'use client';

import { useRef, useState } from 'react';

/**
 * A 360° product view (owner's Batch 2, Pro and Premium sellers): images
 * taken around the product, in order; dragging (or swiping) left and right
 * turns it. Arrow keys work too.
 */
export default function SpinViewer({ images, alt }: { images: string[]; alt: string }) {
  const [frame, setFrame] = useState(0);
  const drag = useRef<{ x: number; start: number } | null>(null);
  if (images.length < 2) return null;
  const step = (n: number) => setFrame((f) => (((f + n) % images.length) + images.length) % images.length);

  return (
    <div
      className="relative select-none overflow-hidden rounded-2xl bg-cream-50"
      data-spin-viewer
      role="img"
      aria-label={`${alt}: 360° view, drag to turn`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') step(-1);
        if (e.key === 'ArrowRight') step(1);
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, start: frame };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        // One frame per 12 px of drag.
        const moved = Math.round((e.clientX - drag.current.x) / 12);
        setFrame((((drag.current.start - moved) % images.length) + images.length) % images.length);
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      style={{ touchAction: 'pan-y' }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={images[frame]} alt="" draggable={false} className="aspect-square w-full object-contain" />
      {/* Preload the rest so turning is smooth. */}
      <div className="hidden">
        {images.map((src) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={src} src={src} alt="" loading="lazy" />
        ))}
      </div>
      <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[11px] font-semibold text-white">
        ⟲ 360° — drag to turn
      </span>
    </div>
  );
}
