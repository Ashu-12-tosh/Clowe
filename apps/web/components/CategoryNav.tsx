'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { CategoryNode } from '@clowe/shared';
import { api } from '@/lib/api';

/** How many category links show inline before the "More" overflow. */
const INLINE_COUNT = 8;

/**
 * Category nav bar: "All Categories" mega menu + inline text links +
 * a "More" overflow. Desktop-only — on mobile the AppShell drawer takes over,
 * and a horizontal scroll strip renders instead.
 */
export default function CategoryNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Nav highlight follows both the listing page and the category landing route.
  const activeSlug =
    pathname === '/products'
      ? (searchParams.get('category') ?? '')
      : pathname.startsWith('/category/')
        ? decodeURIComponent(pathname.split('/')[2] ?? '')
        : '';
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [megaOpen, setMegaOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const navRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api<CategoryNode[]>('/api/categories').then(setTree).catch(() => {});
  }, []);

  // Close menus on outside click / navigation.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setMegaOpen(false);
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);
  useEffect(() => {
    setMegaOpen(false);
    setMoreOpen(false);
  }, [pathname, activeSlug]);

  const inline = tree.slice(0, INLINE_COUNT);
  const overflow = tree.slice(INLINE_COUNT);

  const linkClass = (slug: string) =>
    `t-nav flex shrink-0 items-center gap-1.5 border-b-2 px-1 pb-2 pt-2.5 transition ${
      activeSlug === slug
        ? 'border-brand-600 !font-semibold text-brand-600'
        : 'border-transparent text-gray-700 hover:text-brand-600'
    }`;

  return (
    <div ref={navRef} className="relative border-b border-gray-100 bg-white">
      {/* Desktop row */}
      <div className="mx-auto hidden max-w-7xl items-center gap-5 px-4 lg:flex">
        <button
          onClick={() => {
            setMegaOpen((v) => !v);
            setMoreOpen(false);
          }}
          className={`t-nav flex items-center gap-2 border-b-2 px-1 pb-2 pt-2.5 !font-semibold transition ${
            megaOpen ? 'border-brand-600 text-brand-600' : 'border-transparent text-ink-900 hover:text-brand-600'
          }`}
        >
          ☰ All Categories <span className="text-[10px]">▾</span>
        </button>

        {inline.map((cat) => (
          <Link key={cat.id} href={`/category/${cat.slug}`} className={linkClass(cat.slug)}>
            {cat.name}
          </Link>
        ))}

        {overflow.length > 0 && (
          <div className="relative">
            <button
              onClick={() => {
                setMoreOpen((v) => !v);
                setMegaOpen(false);
              }}
              className={`t-nav flex items-center gap-1.5 border-b-2 px-1 pb-2 pt-2.5 transition ${
                moreOpen ? 'border-brand-600 text-brand-600' : 'border-transparent text-gray-700 hover:text-brand-600'
              }`}
            >
              ☰ More <span className="text-[10px]">▾</span>
            </button>
            {moreOpen && (
              <div className="absolute right-0 top-full z-40 mt-0.5 w-52 overflow-hidden rounded-xl border border-gray-100 bg-white py-1 shadow-xl">
                {overflow.map((cat) => (
                  <Link
                    key={cat.id}
                    href={`/category/${cat.slug}`}
                    className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-cream-100"
                  >
                    {cat.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Mobile: horizontal scroll strip */}
      <div className="scrollbar-none flex items-center gap-4 overflow-x-auto px-4 lg:hidden">
        {tree.map((cat) => (
          <Link key={cat.id} href={`/category/${cat.slug}`} className={linkClass(cat.slug)}>
            <span className="whitespace-nowrap">{cat.name}</span>
          </Link>
        ))}
      </div>

      {/* Mega menu */}
      {megaOpen && (
        <div className="absolute inset-x-0 top-full z-40 hidden border-b border-gray-200 bg-white shadow-2xl lg:block">
          <div className="mx-auto grid max-w-7xl grid-cols-3 gap-x-8 gap-y-6 px-6 py-6 xl:grid-cols-4">
            {tree.map((cat) => (
              <div key={cat.id}>
                <Link
                  href={`/category/${cat.slug}`}
                  className="flex items-center gap-2 text-sm font-bold text-ink-900 hover:text-brand-600"
                >
                  {cat.name}
                </Link>
                <ul className="mt-2 space-y-1.5">
                  {cat.children.slice(0, 6).map((child) => (
                    <li key={child.id}>
                      <Link
                        href={`/category/${cat.slug}?category=${child.slug}`}
                        className="text-sm text-gray-600 hover:text-brand-600 hover:underline"
                      >
                        {child.name}
                      </Link>
                    </li>
                  ))}
                  {cat.children.length > 6 && (
                    <li>
                      <Link
                        href={`/category/${cat.slug}`}
                        className="text-xs font-semibold text-brand-600 hover:underline"
                      >
                        View all →
                      </Link>
                    </li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
