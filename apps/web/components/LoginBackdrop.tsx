'use client';

import { useEffect, useRef } from 'react';
import HomePage from '@/app/page';

/**
 * The real landing page, blurred, sitting behind the auth card — so logging in
 * feels like a sheet over the store rather than a blank white screen.
 *
 * It is decorative only: `inert` takes the whole subtree out of the focus order
 * and pointer handling, so nothing inside is clickable or tabbable.
 */
export default function LoginBackdrop() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // `inert` isn't in React 18's JSX types yet, so set it on the node.
    if (ref.current) ref.current.inert = true;
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 select-none overflow-hidden"
    >
      <div className="origin-top scale-105 opacity-70 blur-[6px]">
        <HomePage />
      </div>
      {/* Wash so the card keeps its contrast over whatever is behind it. */}
      <div className="absolute inset-0 bg-cream-50/75" />
    </div>
  );
}
