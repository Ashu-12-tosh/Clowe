'use client';

import { useEffect, useState } from 'react';

/**
 * Where to draw an image of (w × h) in a box (bw × bh): 'contain' shows all of
 * it, centred; 'cover' fills the box, centred, cropping the overflow.
 */
export function coverRect(w: number, h: number, bw: number, bh: number, fit: 'contain' | 'cover') {
  if (w <= 0 || h <= 0 || bw <= 0 || bh <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = fit === 'cover' ? Math.max(bw / w, bh / h) : Math.min(bw / w, bh / h);
  const width = w * scale;
  const height = h * scale;
  return { x: (bw - width) / 2, y: (bh - height) / 2, width, height };
}

/** How long after Print Screen the image stays hidden. */
export const PRINT_SCREEN_HIDE_MS = 3_000;

/**
 * True while protected media should be hidden: the tab or app is in the
 * background, the window has lost focus (an app switcher, a screenshot tool
 * taking focus), a print is being prepared, or Print Screen was just pressed
 * — when the browser is told at all. On Print Screen the clipboard is also
 * overwritten, which spoils the capture on systems that put it there.
 */
export function useScreenGuard(): boolean {
  const [hidden, setHidden] = useState(false);
  const [blurred, setBlurred] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [snapped, setSnapped] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => setHidden(document.visibilityState !== 'visible');
    const onBlur = () => setBlurred(true);
    const onFocus = () => setBlurred(false);
    const onBeforePrint = () => setPrinting(true);
    const onAfterPrint = () => setPrinting(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'PrintScreen') return;
      setSnapped(true);
      clearTimeout(timer);
      timer = setTimeout(() => setSnapped(false), PRINT_SCREEN_HIDE_MS);
      try {
        void navigator.clipboard?.writeText('').catch(() => {});
      } catch {
        // Not allowed here: hiding is what is left.
      }
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('afterprint', onAfterPrint);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', onAfterPrint);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  return hidden || blurred || printing || snapped;
}
