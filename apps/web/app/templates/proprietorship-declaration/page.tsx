'use client';

/**
 * A sole proprietor's constitution document: a declaration on the business's
 * letterhead or plain paper, filled in by hand, signed, and uploaded with the
 * seller application. "Print / Save as PDF" makes the downloadable copy.
 */
const LINE = 'mt-1 h-7 border-b border-gray-400';

export default function ProprietorshipDeclarationTemplate() {
  return (
    <main className="mx-auto max-w-2xl bg-white px-6 py-10 text-[15px] leading-relaxed text-black print:px-0 print:py-0" data-proprietorship-declaration>
      <div className="mb-6 flex items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-gray-600">Print it, or save it as a PDF, fill it in, sign it and upload it as your constitution document.</p>
        <button type="button" onClick={() => window.print()} className="shrink-0 rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white">
          Print / Save as PDF
        </button>
      </div>

      <h1 className="text-center text-xl font-bold uppercase tracking-wide">Declaration of Sole Proprietorship</h1>
      <p className="mt-1 text-center text-sm">(To be given on the business letterhead, where there is one)</p>

      <p className="mt-8">To,</p>
      <p>CLOWE PARTNERS LLP</p>

      <p className="mt-6">I, the undersigned, declare that:</p>
      <ol className="mt-3 list-decimal space-y-3 pl-6">
        <li>
          I am the sole proprietor of the business named below, and no other person is a partner in it or has a share in its
          ownership.
        </li>
        <li>The particulars given below are true and correct.</li>
        <li>I will inform Clowe in writing of any change to these particulars, or in the constitution of the business.</li>
      </ol>

      <div className="mt-8 space-y-5">
        <div>
          <p className="font-semibold">Name of the business (trade name)</p>
          <div className={LINE} />
        </div>
        <div>
          <p className="font-semibold">Name of the proprietor</p>
          <div className={LINE} />
        </div>
        <div>
          <p className="font-semibold">Address of the business</p>
          <div className={LINE} />
          <div className={LINE} />
        </div>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="font-semibold">PAN of the proprietor</p>
            <div className={LINE} />
          </div>
          <div>
            <p className="font-semibold">GSTIN</p>
            <div className={LINE} />
          </div>
        </div>
      </div>

      <div className="mt-12 grid grid-cols-2 gap-6">
        <div>
          <p className="font-semibold">Place</p>
          <div className={LINE} />
          <p className="mt-5 font-semibold">Date</p>
          <div className={LINE} />
        </div>
        <div>
          <div className="mt-16 border-b border-gray-400" />
          <p className="mt-1 text-center font-semibold">Signature of the proprietor</p>
          <p className="text-center text-sm">(with the business stamp, where there is one)</p>
        </div>
      </div>
    </main>
  );
}
