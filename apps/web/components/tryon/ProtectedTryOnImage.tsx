'use client';

import { useEffect, useRef, useState } from 'react';
import { coverRect, useScreenGuard } from '@/lib/protectedMedia';

/**
 * A try-on result (a shopper's likeness), made as hard to save as a web page
 * allows (pre-launch audit 2026-10-20, D3):
 *
 *  - drawn on a canvas from a short-lived private link — there is no <img> to
 *    "Save image as…", drag out, or long-press to save, and the link expires
 *    in two minutes;
 *  - right-click, drag, selection and the iOS long-press menu are off;
 *  - blurred when the tab or app is in the background, the window loses
 *    focus, or Print Screen is pressed (best effort: the browser is told
 *    after the fact, and not every system tells it at all);
 *  - never printed: the print stylesheet hides it (globals.css,
 *    [data-protected-media]), and the canvas is cleared before printing;
 *  - the image itself carries a visible watermark — the account and the time
 *    — burned in on the server, so a copy that gets out still says whose it is.
 *
 * What a web page cannot stop: a phone's own screenshot or screen recording,
 * another device's camera, or someone determined with the browser's developer
 * tools. The watermark is what answers those.
 */
export default function ProtectedTryOnImage({
  src,
  alt,
  fit = 'contain',
  className = '',
}: {
  src: string;
  alt: string;
  fit?: 'contain' | 'cover';
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const guarded = useScreenGuard();

  // Load off-page: the element never joins the document.
  useEffect(() => {
    let live = true;
    setFailed(false);
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => live && setImage(img);
    img.onerror = () => live && setFailed(true);
    img.src = src;
    return () => {
      live = false;
      img.onload = null;
      img.onerror = null;
      img.src = '';
    };
  }, [src]);

  // Draw to fit the box, sharp on high-density screens; redraw on resize.
  useEffect(() => {
    const c = canvas.current;
    const b = box.current;
    if (!c || !b || !image) return;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const { width, height } = b.getBoundingClientRect();
      c.width = Math.max(1, Math.round(width * ratio));
      c.height = Math.max(1, Math.round(height * ratio));
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      const r = coverRect(image.naturalWidth, image.naturalHeight, c.width, c.height, fit);
      ctx.drawImage(image, r.x, r.y, r.width, r.height);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(b);
    // Printing: nothing on the canvas (the stylesheet also hides it).
    const clear = () => c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    window.addEventListener('beforeprint', clear);
    window.addEventListener('afterprint', draw);
    return () => {
      observer.disconnect();
      window.removeEventListener('beforeprint', clear);
      window.removeEventListener('afterprint', draw);
      clear();
    };
  }, [image, fit]);

  const block = (e: React.SyntheticEvent) => e.preventDefault();

  return (
    <div
      ref={box}
      role="img"
      aria-label={alt}
      data-protected-media
      onContextMenu={block}
      onDragStart={block}
      onCopy={block}
      className={`relative select-none overflow-hidden [-webkit-touch-callout:none] [-webkit-user-select:none] ${className}`}
    >
      <canvas
        ref={canvas}
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full transition-[filter] duration-150 ${guarded ? 'blur-2xl' : ''}`}
        onContextMenu={block}
        onDragStart={block}
      />
      {/* Covers the canvas for pointer and touch, so nothing reaches the image itself. */}
      <div className="absolute inset-0" aria-hidden="true" />
      {guarded && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm font-semibold text-white [text-shadow:0_1px_3px_rgba(0,0,0,.6)]" data-protected-hidden>
          Hidden while you&apos;re away
        </div>
      )}
      {!image && !failed && <div className="absolute inset-0 animate-pulse bg-cream-100" aria-hidden="true" />}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-gray-500">This image has expired — reload the page to see it again.</div>
      )}
    </div>
  );
}
