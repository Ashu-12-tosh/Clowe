'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { invoiceMonthLabel, type SellerMonthlyInvoice } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import BrandLogo from '@/components/BrandLogo';

/** Clowe's tax invoice to the seller for one month — print or save as PDF from the browser. */
export default function SellerInvoicePage({ params }: { params: Promise<{ month: string }> }) {
  const { month } = use(params);
  const [doc, setDoc] = useState<SellerMonthlyInvoice | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<SellerMonthlyInvoice>(`/api/seller/billing/invoices/${month}`, { auth: true })
      .then(setDoc)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load the invoice'));
  }, [month]);

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!doc) return <p className="text-sm text-gray-500">Loading…</p>;
  const money = (p: number) => formatPaise(p);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between print:hidden">
        <Link href="/seller/billing" className="text-sm font-semibold text-brand-600 hover:underline">
          ← Billing
        </Link>
        <button onClick={() => window.print()} className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold text-white">
          Download / print
        </button>
      </div>
      <article className="rounded-2xl border border-gray-200 bg-white p-6 text-sm" data-seller-invoice>
        {/* Clowe issues this one: its wordmark heads the page. */}
        <BrandLogo tone="black" height={30} className="mb-4 w-[120px]" />
        <div className="flex flex-wrap justify-between gap-4">
          <div>
            <p className="text-lg font-bold text-ink-900">{doc.number ? 'TAX INVOICE' : 'DRAFT — not a tax invoice yet'}</p>
            <p className="text-xs text-gray-500">
              {invoiceMonthLabel(doc.month)} {doc.number ? `· ${doc.number}` : ''}
              {doc.issuedAt ? ` · issued ${new Date(doc.issuedAt).toLocaleDateString('en-IN')}` : ''}
            </p>
          </div>
          <div className="text-right text-xs">
            <p className="font-bold text-ink-900">{doc.supplier.name}</p>
            <p>{doc.supplier.address}</p>
            {doc.supplier.gstin && <p>GSTIN {doc.supplier.gstin}</p>}
          </div>
        </div>
        <div className="mt-4 text-xs">
          <p className="font-semibold text-gray-500">Billed to</p>
          <p className="font-bold text-ink-900">{doc.recipient.name}</p>
          <p>{doc.recipient.address}</p>
          {doc.recipient.gstin && <p>GSTIN {doc.recipient.gstin}</p>}
          <p className="mt-1 text-gray-500">{doc.intraState ? 'Intra-state supply: CGST + SGST' : 'Inter-state supply: IGST'}</p>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="py-1">Description</th>
                <th>SAC</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">GST</th>
                <th className="text-right">{doc.intraState ? 'CGST + SGST' : 'IGST'}</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={l.key} className="border-b border-gray-100">
                  <td className="py-1">{l.label}</td>
                  <td>{l.sac}</td>
                  <td className="text-right">{money(l.taxablePaise)}</td>
                  <td className="text-right">{l.gstRatePercent}%</td>
                  <td className="text-right">{money(l.cgstPaise + l.sgstPaise + l.igstPaise)}</td>
                  <td className="text-right font-semibold">{money(l.totalPaise)}</td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className="py-1">Total</td>
                <td />
                <td className="text-right">{money(doc.totals.taxablePaise)}</td>
                <td />
                <td className="text-right">{money(doc.totals.cgstPaise + doc.totals.sgstPaise + doc.totals.igstPaise)}</td>
                <td className="text-right">{money(doc.totals.totalPaise)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <ul className="mt-4 list-disc pl-4 text-[11px] text-gray-500">
          {doc.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </article>
    </div>
  );
}
