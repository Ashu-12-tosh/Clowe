'use client';

import { returnRuleText } from '@clowe/shared';
import { useClaimWindowHours } from '@/lib/returnWindow';
import NotReturnable from './NotReturnable';

/**
 * The returns rule for one item, wherever a buyer sees it — product page,
 * cart, checkout and the order: "48-hour claim window for damaged, wrong or
 * defective items" (no change-of-mind returns), or "Not returnable".
 */
export default function ReturnRule({ returnable, className = '' }: { returnable: boolean; className?: string }) {
  const hours = useClaimWindowHours();
  if (!returnable) return <NotReturnable className={className} />;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] text-gray-500 ${className}`} data-return-rule>
      <span aria-hidden>↩</span>
      {returnRuleText(true, hours)}
    </span>
  );
}
