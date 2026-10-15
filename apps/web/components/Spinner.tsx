/** A small inline spinner for a button that is waiting on the server. */
export default function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px] ${className}`}
    />
  );
}
