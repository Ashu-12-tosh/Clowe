import type { CreditNote } from '@clowe/shared';
import { formatPaise } from '@/lib/format';

const money = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/**
 * A GST credit note, as the seller and the buyer both see it: issued by the
 * seller (the supplier on the invoice), naming the invoice it reduces, and
 * crediting the returned line at exactly what that invoice charged — the same
 * rate, HSN and CGST + SGST / IGST split. Laid out like the tax invoice.
 */
export default function CreditNoteDocument({ note }: { note: CreditNote }) {
  const s = note.seller;
  const intra = note.isIntraState;
  return (
    <article className="print-sheet rounded-xl border border-gray-300 bg-white p-6" data-credit-note={note.creditNoteNumber}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-4">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Credit note · issued by</p>
          <p className="mt-1 text-base font-bold text-ink-900">{s.legalName}</p>
          {s.legalName !== s.shopName && <p className="text-xs text-gray-600">Trading as {s.shopName}</p>}
          <p className="text-xs leading-relaxed text-gray-600">
            {[s.line1, [s.city, s.state, s.pincode].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || '—'}
            <br />
            GSTIN: <span className="font-semibold text-ink-900">{s.gstNumber ?? 'not on file'}</span>
            {s.panNumber && <> · PAN: {s.panNumber}</>}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-gray-600">
            Sold through <span className="font-semibold text-ink-900">{note.marketplace.name}</span> (marketplace)
            {note.marketplace.gstin && <> · GSTIN {note.marketplace.gstin}</>}
            {note.marketplace.address && (
              <>
                <br />
                {note.marketplace.address}
              </>
            )}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-sm font-bold text-ink-900">{note.creditNoteNumber}</p>
          <p className="mt-1 text-xs text-gray-600">
            Issued {day(note.issuedAt)}
            <br />
            Order {note.orderNumber}
          </p>
          <p className="mt-2 rounded-md bg-cream-50 px-2 py-1 text-left text-[11px] leading-snug text-gray-700">
            Against tax invoice <span className="font-mono font-semibold">{note.original.invoiceNumber}</span>
            <br />
            dated {day(note.original.issuedAt)}
          </p>
        </div>
      </header>

      <section className="grid gap-6 py-4 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Bill to</p>
          <p className="mt-1 text-sm font-semibold text-ink-900">{note.billTo.name}</p>
          <p className="text-xs leading-relaxed text-gray-600">
            {note.billTo.line1}
            {note.billTo.line2 && <>, {note.billTo.line2}</>}
            <br />
            {note.billTo.city}, {note.billTo.state} — {note.billTo.pincode}
          </p>
          {note.buyerGstin && <p className="mt-1 text-xs font-semibold text-gray-700">GSTIN: {note.buyerGstin}</p>}
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Reason</p>
          <p className="mt-1 text-xs text-gray-600">{note.reason}</p>
          <p className="mt-1 text-xs text-gray-600">Place of supply: {note.billTo.state}</p>
        </div>
      </section>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-y border-gray-200 text-left uppercase tracking-wide text-gray-500">
              <th className="py-2 font-semibold">Item credited</th>
              <th className="py-2 font-semibold">HSN</th>
              <th className="py-2 text-right font-semibold">Qty</th>
              <th className="py-2 text-right font-semibold">Unit price</th>
              <th className="py-2 text-right font-semibold">Taxable</th>
              <th className="py-2 text-right font-semibold">GST</th>
              <th className="py-2 text-right font-semibold">{intra ? 'CGST + SGST' : 'IGST'}</th>
              <th className="py-2 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {note.lines.map((line, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="py-2">
                  {line.title}
                  {line.variantLabel && <span className="block text-[11px] text-gray-500">{line.variantLabel}</span>}
                </td>
                <td className="py-2">{line.hsnCode ?? '—'}</td>
                <td className="py-2 text-right">{line.quantity}</td>
                <td className="py-2 text-right">{money(line.unitPricePaise)}</td>
                <td className="py-2 text-right">{money(line.taxablePaise)}</td>
                <td className="py-2 text-right">{line.gstRatePercent}%</td>
                <td className="py-2 text-right">{intra ? `${money(line.cgstPaise)} + ${money(line.sgstPaise)}` : money(line.igstPaise)}</td>
                <td className="py-2 text-right font-semibold">{money(line.grossPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mt-4 flex justify-end">
        <dl className="w-64 space-y-1 text-xs">
          <div className="flex justify-between">
            <dt className="text-gray-500">Taxable value credited</dt>
            <dd>{money(note.taxablePaise)}</dd>
          </div>
          {intra ? (
            <>
              <div className="flex justify-between">
                <dt className="text-gray-500">CGST credited</dt>
                <dd>{money(note.cgstPaise)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">SGST credited</dt>
                <dd>{money(note.sgstPaise)}</dd>
              </div>
            </>
          ) : (
            <div className="flex justify-between">
              <dt className="text-gray-500">IGST credited</dt>
              <dd>{money(note.igstPaise)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-gray-200 pt-1.5 text-sm font-bold text-ink-900">
            <dt>Credit note total</dt>
            <dd>{formatPaise(note.totalPaise)}</dd>
          </div>
        </dl>
      </section>

      <footer className="mt-6 border-t border-gray-200 pt-3 text-[11px] leading-relaxed text-gray-500">
        <p>
          Credit note under section 34 of the CGST Act, 2017, reducing the taxable value and tax of tax invoice{' '}
          {note.original.invoiceNumber} for the goods above, returned by the recipient. Computer-generated, issued by{' '}
          {s.legalName} for goods sold through {note.marketplace.name}; does not require a signature.
        </p>
      </footer>
    </article>
  );
}
