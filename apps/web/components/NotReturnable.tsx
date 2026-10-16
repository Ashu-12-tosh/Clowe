/**
 * Said wherever a buyer decides on an item that cannot be returned — the
 * product page, cart, checkout and the order — so nobody finds out after
 * buying. The category decides (Admin → Categories → Returnable).
 */
export default function NotReturnable({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border border-red-100 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700 ${className}`}
      data-not-returnable
    >
      Not returnable
    </span>
  );
}
