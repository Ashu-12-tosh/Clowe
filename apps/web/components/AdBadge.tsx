import type { AdLabel } from '@clowe/shared';

/** The label shoppers see on every paid item. */
export default function AdBadge({ label, className = '' }: { label: AdLabel; className?: string }) {
  return (
    <span
      className={`inline-block rounded border border-gray-300 bg-white/90 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-gray-600 ${className}`}
      title="Paid placement"
    >
      {label}
    </span>
  );
}
