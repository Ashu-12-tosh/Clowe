import PDFDocument from 'pdfkit';
import { invoiceMonthLabel, type SellerMonthlyInvoice } from '@clowe/shared';

// ---------------------------------------------------------------------------
// Clowe's monthly tax invoice to a seller, as a PDF (owner, 26 Oct): what the
// Billing page shows, with what CGST Rules rule 46 asks of a tax invoice —
// both parties and their GSTINs, a number of at most 16 characters, the
// date, the place of supply, each charge with its SAC, taxable value, rate
// and tax, and the totals. A month still running is marked a draft.
//
// The built-in Helvetica has no rupee sign, so amounts are in INR figures.
// ---------------------------------------------------------------------------

const MARGIN = 40;
const WIDTH = 595.28 - MARGIN * 2; // A4

function inr(paise: number): string {
  return (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function istDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

/** The invoice as PDF bytes. */
export function renderSellerInvoicePdf(doc: SellerMonthlyInvoice): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `Clowe tax invoice ${doc.number ?? 'draft'}`, Author: doc.supplier.name } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });

  pdf.font('Helvetica-Bold').fontSize(16).text(doc.number ? 'TAX INVOICE' : 'DRAFT — NOT A TAX INVOICE', { align: 'center' });
  pdf.moveDown(0.2).font('Helvetica').fontSize(9).fillColor('#555').text(`For Clowe's charges in ${invoiceMonthLabel(doc.month)}`, { align: 'center' });
  pdf.fillColor('#000').moveDown(1);

  // Parties, side by side.
  const top = pdf.y;
  const half = WIDTH / 2 - 10;
  const party = (x: number, title: string, p: SellerMonthlyInvoice['supplier']) => {
    pdf.font('Helvetica-Bold').fontSize(9).text(title, x, top, { width: half });
    pdf.font('Helvetica-Bold').fontSize(10).text(p.name, x, pdf.y + 2, { width: half });
    pdf.font('Helvetica').fontSize(9).text(p.address || '—', x, pdf.y + 1, { width: half });
    if (p.state) pdf.text(`State: ${p.state}`, x, pdf.y, { width: half });
    pdf.text(`GSTIN: ${p.gstin ?? 'Unregistered'}`, x, pdf.y, { width: half });
    return pdf.y;
  };
  const leftEnd = party(MARGIN, 'Supplier', doc.supplier);
  const rightEnd = party(MARGIN + half + 20, 'Recipient (seller)', doc.recipient);
  pdf.y = Math.max(leftEnd, rightEnd) + 12;

  const meta: [string, string][] = [
    ['Invoice number', doc.number ?? 'Draft (numbered when the month ends)'],
    ['Invoice date', doc.issuedAt ? istDate(doc.issuedAt) : '—'],
    ['Place of supply', doc.placeOfSupply ?? doc.recipient.state ?? '—'],
    ['Tax', doc.intraState ? 'CGST + SGST (intra-state)' : 'IGST (inter-state)'],
    ['Reverse charge', 'No'],
  ];
  for (const [k, v] of meta) {
    const y = pdf.y;
    pdf.font('Helvetica-Bold').fontSize(9).text(k, MARGIN, y, { width: 110 });
    pdf.font('Helvetica').text(v, MARGIN + 110, y, { width: WIDTH - 110 });
  }
  pdf.moveDown(1);

  // Lines.
  const cols = doc.intraState
    ? [
        { h: 'Description', w: 160, a: 'left' as const },
        { h: 'SAC', w: 45, a: 'left' as const },
        { h: 'Taxable (INR)', w: 70, a: 'right' as const },
        { h: 'Rate', w: 35, a: 'right' as const },
        { h: 'CGST', w: 60, a: 'right' as const },
        { h: 'SGST', w: 60, a: 'right' as const },
        { h: 'Total (INR)', w: WIDTH - 430, a: 'right' as const },
      ]
    : [
        { h: 'Description', w: 190, a: 'left' as const },
        { h: 'SAC', w: 50, a: 'left' as const },
        { h: 'Taxable (INR)', w: 80, a: 'right' as const },
        { h: 'Rate', w: 40, a: 'right' as const },
        { h: 'IGST', w: 70, a: 'right' as const },
        { h: 'Total (INR)', w: WIDTH - 430, a: 'right' as const },
      ];
  const row = (cells: string[], bold = false) => {
    const y = pdf.y;
    let x = MARGIN;
    let bottom = y;
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    cells.forEach((c, i) => {
      pdf.text(c, x + 2, y, { width: cols[i]!.w - 4, align: cols[i]!.a });
      bottom = Math.max(bottom, pdf.y);
      x += cols[i]!.w;
    });
    pdf.y = bottom + 3;
    pdf.moveTo(MARGIN, pdf.y - 1).lineTo(MARGIN + WIDTH, pdf.y - 1).strokeColor('#ddd').lineWidth(0.5).stroke();
  };
  row(cols.map((c) => c.h), true);
  for (const l of doc.lines) {
    const tax = doc.intraState ? [inr(l.cgstPaise), inr(l.sgstPaise)] : [inr(l.igstPaise)];
    row([l.label, l.sac, inr(l.taxablePaise), `${l.gstRatePercent}%`, ...tax, inr(l.totalPaise)]);
  }
  const t = doc.totals;
  row(['Total', '', inr(t.taxablePaise), '', ...(doc.intraState ? [inr(t.cgstPaise), inr(t.sgstPaise)] : [inr(t.igstPaise)]), inr(t.totalPaise)], true);

  pdf.moveDown(0.8).font('Helvetica-Bold').fontSize(10).text(`Amount payable: INR ${inr(t.totalPaise)}`, MARGIN, pdf.y, { width: WIDTH, align: 'right' });
  pdf.moveDown(1).font('Helvetica').fontSize(8).fillColor('#444');
  for (const n of doc.notes) pdf.text(`• ${n}`, MARGIN, pdf.y, { width: WIDTH });
  pdf.moveDown(1).text('This is a computer-generated invoice and needs no signature.', MARGIN, pdf.y, { width: WIDTH });
  pdf.text(`For ${doc.supplier.name} — authorised signatory`, MARGIN, pdf.y, { width: WIDTH });
  pdf.end();
  return done;
}
