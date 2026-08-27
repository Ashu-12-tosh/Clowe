'use client';

import type { SellerStoreSettings } from '@clowe/shared';

/** Live mock of the public store page, driven by the form state. */
export default function StorePreview({ s }: { s: SellerStoreSettings }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
      <div className="relative h-28 bg-ink-900">
        {s.bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.bannerUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-gray-500">
            Add a banner (1920×600)
          </div>
        )}
      </div>

      <div className="px-4 pb-4">
        <div className="-mt-7 flex items-end gap-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border-4 border-white bg-ink-900 text-sm font-bold text-white">
            {s.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.logoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              s.shopName.slice(0, 2).toUpperCase()
            )}
          </span>
          <div className="min-w-0 pb-1">
            <p className="flex items-center gap-1.5 truncate text-sm font-bold text-ink-900">
              {s.shopName || 'Your store name'}
              {s.kycStatus === 'VERIFIED' && (
                <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700">
                  ✓ Verified
                </span>
              )}
            </p>
            <p className="truncate text-[11px] text-gray-500">
              {s.primaryCategoryName ?? 'Set a primary category'}
              {s.city && ` · ${s.city}`}
            </p>
          </div>
        </div>

        {s.tagline && <p className="mt-2 text-xs font-medium text-ink-900">{s.tagline}</p>}
        {s.description && (
          <p className="mt-1 line-clamp-2 text-[11px] text-gray-500">{s.description}</p>
        )}

        {s.vacationMode && (
          <p className="mt-2 rounded-lg bg-yellow-50 px-2.5 py-1.5 text-[11px] text-yellow-800">
            🌴 {s.vacationMessage ?? 'On a short break — orders are paused.'}
          </p>
        )}

        {s.highlights.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {s.highlights.slice(0, 4).map((h) => (
              <div key={h.title} className="rounded-lg bg-cream-50 px-2 py-1.5">
                <p className="text-[11px] font-semibold text-ink-900">
                  {h.icon} {h.title}
                </p>
                <p className="truncate text-[10px] text-gray-500">{h.subtitle}</p>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-2 text-[11px] text-gray-500">
          <span>{s.liveProductCount} live products</span>
          <span>{s.effectiveReturnWindowDays}-day returns</span>
        </div>
      </div>
    </div>
  );
}
