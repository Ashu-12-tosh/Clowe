'use client';

/** Body measurements in inches — the standard India apparel chart. */
const APPAREL_ROWS = [
  { size: 'XS', chest: '34', waist: '28', length: '26' },
  { size: 'S', chest: '36', waist: '30', length: '27' },
  { size: 'M', chest: '38', waist: '32', length: '28' },
  { size: 'L', chest: '40', waist: '34', length: '29' },
  { size: 'XL', chest: '42', waist: '36', length: '30' },
  { size: 'XXL', chest: '44', waist: '38', length: '31' },
];

/** UK ↔ EU ↔ foot length for shoes. */
const FOOTWEAR_ROWS = [
  { size: 'UK 6', eu: '40', cm: '24.5' },
  { size: 'UK 7', eu: '41', cm: '25.4' },
  { size: 'UK 8', eu: '42', cm: '26.2' },
  { size: 'UK 9', eu: '43', cm: '27.1' },
  { size: 'UK 10', eu: '44', cm: '27.9' },
];

interface Props {
  /** Sizes the product actually offers — the matching row is highlighted. */
  sizes: string[];
  selectedSize: string | null;
  onClose: () => void;
}

export default function SizeGuideModal({ sizes, selectedSize, onClose }: Props) {
  const isFootwear = sizes.some((s) => s.toUpperCase().startsWith('UK'));
  const rows = isFootwear ? FOOTWEAR_ROWS : APPAREL_ROWS;
  const available = new Set(sizes);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Size guide"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Size Guide</h2>
          <button
            onClick={onClose}
            aria-label="Close size guide"
            className="rounded-full p-1.5 text-xl leading-none text-gray-400 hover:bg-gray-100"
          >
            ×
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {isFootwear
            ? 'Measure your foot from heel to longest toe.'
            : 'Body measurements in inches. If you are between sizes, size up.'}
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="py-2 pr-3 font-bold">Size</th>
                {isFootwear ? (
                  <>
                    <th className="py-2 pr-3 font-bold">EU</th>
                    <th className="py-2 font-bold">Foot (cm)</th>
                  </>
                ) : (
                  <>
                    <th className="py-2 pr-3 font-bold">Chest</th>
                    <th className="py-2 pr-3 font-bold">Waist</th>
                    <th className="py-2 font-bold">Length</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const offered = available.has(row.size);
                const current = selectedSize === row.size;
                return (
                  <tr
                    key={row.size}
                    className={`border-b border-gray-100 ${
                      current ? 'bg-brand-50 font-semibold text-ink-900' : offered ? '' : 'text-gray-300'
                    }`}
                  >
                    <td className="py-2 pr-3">
                      {row.size}
                      {!offered && <span className="ml-1.5 text-[10px]">(not stocked)</span>}
                    </td>
                    {'eu' in row ? (
                      <>
                        <td className="py-2 pr-3">{row.eu}</td>
                        <td className="py-2">{row.cm}</td>
                      </>
                    ) : (
                      <>
                        <td className="py-2 pr-3">{row.chest}</td>
                        <td className="py-2 pr-3">{row.waist}</td>
                        <td className="py-2">{row.length}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <button
          onClick={onClose}
          className="mt-5 w-full rounded-lg bg-ink-900 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
