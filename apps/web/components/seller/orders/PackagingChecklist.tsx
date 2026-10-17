import { ExternalLink } from '@/components/ExternalLink';

/** Delhivery's packaging guidelines, in full. */
export const DELHIVERY_PACKAGING_GUIDELINES_URL = 'https://help.delhivery.com/docs/packaging-guidelines';

/**
 * The short version of Delhivery's packaging guidelines, beside the packing
 * video: a parcel packed this way survives the sorting belts, and a damage
 * claim isn't refused for poor packing.
 */
export function PackagingChecklist() {
  return (
    <details className="rounded-2xl border border-gray-100 bg-white p-4 text-xs text-gray-700" data-packaging-checklist>
      <summary className="cursor-pointer text-sm font-semibold text-ink-900">Packing checklist (Delhivery&apos;s guidelines)</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <strong>Box:</strong> 3-ply corrugated for items under 4 kg that aren&apos;t fragile; 5-ply for heavier or fragile items. No holes,
          tears or crushed edges, and not much bigger than the item.
        </li>
        <li>
          <strong>Flyer / polybag</strong> (clothes and other soft items): 60–80 micron, sealed properly.
        </li>
        <li>
          <strong>Worth over ₹7,000:</strong> a tamper-evident box or polybag.
        </li>
        <li>
          <strong>Inside:</strong> bubble wrap or foam so nothing moves; seal liquids against leaks (tape the cap, zip-lock pouch).
        </li>
        <li>
          <strong>Seal:</strong> BOPP tape along the centre seam, top and bottom; H-tape heavy boxes.
        </li>
        <li>
          <strong>Label:</strong> on a flat face, away from seams and edges, flat and fully visible (tape over a flyer&apos;s label pocket).
          A thermal printer is best. Add a FRAGILE sticker where it applies.
        </li>
        <li>
          <strong>Weight and size:</strong> what you book must match the packed box — Delhivery re-weighs it, and a difference is charged.
        </li>
      </ul>
      <p className="mt-2">
        <ExternalLink href={DELHIVERY_PACKAGING_GUIDELINES_URL} className="font-semibold text-brand-600 hover:underline">
          Delhivery&apos;s full packaging guidelines ↗
        </ExternalLink>
      </p>
    </details>
  );
}
