import type { ReactNode } from 'react';
import type { TaxInvoice } from '@clowe/shared';
import { formatPaise } from '@/lib/format';

const money = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * One seller's tax invoice, as the seller and the buyer both see it. The
 * seller is the supplier — legal name, GSTIN, address — and the marketplace
 * the sale went through is named under it. Each line carries its own HSN and
 * rate, with GST split CGST + SGST for a same-state supply, IGST otherwise.
 */
export default function TaxInvoiceDocument({
  invoice,
  payment,
  qr,
}: {
  invoice: TaxInvoice;
  /** The payment line, in the reader's terms. */
  payment: ReactNode;
  /** The seller's copy carries a QR code back to the order. */
  qr?: ReactNode;
}) {
  const s = invoice.seller;
  const intra = invoice.isIntraState;
  return (
    <article className="print-sheet rounded-xl border border-gray-300 bg-white p-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-4">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Tax invoice · issued by</p>
          <p className="mt-1 text-base font-bold text-ink-900">{s.legalName}</p>
          {s.legalName !== s.shopName && <p className="text-xs text-gray-600">Trading as {s.shopName}</p>}
          <p className="text-xs leading-relaxed text-gray-600">
            {[s.line1, [s.city, s.state, s.pincode].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || '—'}
            <br />
            GSTIN: <span className="font-semibold text-ink-900">{s.gstNumber ?? 'not on file'}</span>
            {s.panNumber && <> · PAN: {s.panNumber}</>}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-gray-600">
            Sold through <span className="font-semibold text-ink-900">{invoice.marketplace.name}</span> (marketplace)
            {invoice.marketplace.gstin && <> · GSTIN {invoice.marketplace.gstin}</>}
            {invoice.marketplace.address && (
              <>
                <br />
                {invoice.marketplace.address}
              </>
            )}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-sm font-bold text-ink-900">{invoice.invoiceNumber}</p>
          <p className="mt-1 text-xs text-gray-600">
            Issued {new Date(invoice.issuedAt).toLocaleDateString('en-IN')}
            <br />
            Order {invoice.orderNumber}
            <br />
            Placed {new Date(invoice.placedAt).toLocaleDateString('en-IN')}
          </p>
          {qr}
        </div>
      </header>

      <section className="grid gap-6 py-4 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Bill to</p>
          <p className="mt-1 text-sm font-semibold text-ink-900">{invoice.billTo.name}</p>
          <p className="text-xs leading-relaxed text-gray-600">
            {invoice.billTo.line1}
            {invoice.billTo.line2 && <>, {invoice.billTo.line2}</>}
            <br />
            {invoice.billTo.city}, {invoice.billTo.state} — {invoice.billTo.pincode}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Payment</p>
          <div className="mt-1 text-xs text-gray-600">{payment}</div>
          <p className="mt-1 text-xs text-gray-600">Place of supply: {invoice.billTo.state}</p>
        </div>
      </section>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-y border-gray-200 text-left uppercase tracking-wide text-gray-500">
              <th className="py-2 font-semibold">Item</th>
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
            {invoice.lines.map((line, i) => (
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
                <td className="py-2 text-right">
                  {intra ? `${money(line.cgstPaise)} + ${money(line.sgstPaise)}` : money(line.igstPaise)}
                </td>
                <td className="py-2 text-right font-semibold">{money(line.grossPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mt-4 flex justify-end">
        <dl className="w-64 space-y-1 text-xs">
          <div className="flex justify-between">
            <dt className="text-gray-500">Taxable value</dt>
            <dd>{money(invoice.taxablePaise)}</dd>
          </div>
          {intra ? (
            <>
              <div className="flex justify-between">
                <dt className="text-gray-500">CGST</dt>
                <dd>{money(invoice.cgstPaise)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">SGST</dt>
                <dd>{money(invoice.sgstPaise)}</dd>
              </div>
            </>
          ) : (
            <div className="flex justify-between">
              <dt className="text-gray-500">IGST</dt>
              <dd>{money(invoice.igstPaise)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-gray-200 pt-1.5 text-sm font-bold text-ink-900">
            <dt>Invoice total</dt>
            <dd>{formatPaise(invoice.totalPaise)}</dd>
          </div>
        </dl>
      </section>

      <footer className="mt-6 border-t border-gray-200 pt-3 text-[11px] leading-relaxed text-gray-500">
        <p>
          Prices include GST at each line&rsquo;s rate, as sold. This is a computer-generated invoice issued by{' '}
          {s.legalName} for goods sold through {invoice.marketplace.name}, and does not require a signature.
        </p>
      </footer>
    </article>
  );
}
