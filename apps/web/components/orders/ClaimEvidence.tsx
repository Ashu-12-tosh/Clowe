import type { ClaimEvidenceView } from '@clowe/shared';
import { ExternalLink } from '@/components/ExternalLink';
import { formatPaise } from '@/lib/format';

/** A Return Policy claim's evidence (3.2) and what the buyer asked for — for the seller and the desk. */
export function ClaimEvidence({ claim }: { claim: ClaimEvidenceView }) {
  const group = (title: string, urls: string[]) =>
    urls.length > 0 && (
      <div className="mt-3">
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{title}</p>
        <div className="mt-1 flex gap-2">
          {urls.map((url) => (
            <ExternalLink key={url} href={url}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={title} className="h-20 w-20 rounded-lg object-cover transition hover:opacity-80" />
            </ExternalLink>
          ))}
        </div>
      </div>
    );
  return (
    <div className="mt-3 rounded-xl border border-gray-100 bg-cream-50 p-3" data-claim-evidence>
      <p className="text-xs text-gray-700">
        Claim under the Return Policy · the buyer asks for{' '}
        <span className="font-bold text-ink-900">{claim.remedy === 'EXCHANGE' ? 'an exchange (identical item)' : 'a refund'}</span>
      </p>
      {claim.latentNoticedAt && (
        <p className="mt-1 text-xs text-gray-700">
          Hidden defect, noticed on {new Date(claim.latentNoticedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
        </p>
      )}
      {group('Brand tag and barcode', claim.tagPhotos)}
      {group('Packaging and shipping label', claim.packagingPhotos)}
      {claim.unboxingVideoUrl && (
        <div className="mt-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Buyer&apos;s unboxing video</p>
          <video src={claim.unboxingVideoUrl} controls preload="metadata" className="mt-1 max-h-64 w-full rounded-lg bg-black" />
        </div>
      )}
      {claim.qcNote && <p className="mt-3 text-xs text-red-700">Quality check: {claim.qcNote}</p>}
      {claim.selfShip && (
        <p className="mt-3 text-xs text-amber-800">
          Self-shipped by the buyer (pickup not serviceable)
          {claim.selfShip.costPaise ? ` · receipt for ${formatPaise(claim.selfShip.costPaise)}` : ' · receipt not yet uploaded'}
          {claim.selfShip.reimbursedPaise ? ` · reimbursed ${formatPaise(claim.selfShip.reimbursedPaise)}` : ''}
          {claim.selfShip.receiptUrl && (
            <>
              {' '}
              ·{' '}
              <ExternalLink href={claim.selfShip.receiptUrl} className="font-semibold underline">
                receipt
              </ExternalLink>
            </>
          )}
        </p>
      )}
      {claim.buyerUnderReview && <p className="mt-3 text-xs font-semibold text-red-700">Buyer under review: {claim.buyerUnderReview}</p>}
    </div>
  );
}
