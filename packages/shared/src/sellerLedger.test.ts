import { describe, expect, it } from 'vitest';
import { RETURN_PICKUP_NOTE, SELLER_LEDGER_TYPE_LABELS } from './sellerLedger';

describe('return pickup note (Store Settings → Returns)', () => {
  it('says the seller pays for the pickup, not the marketplace', () => {
    expect(RETURN_PICKUP_NOTE).toMatch(/paid for by you/);
    expect(RETURN_PICKUP_NOTE).not.toMatch(/marketplace/i);
  });

  it('names the ledger line the charge appears as', () => {
    expect(RETURN_PICKUP_NOTE).toContain(SELLER_LEDGER_TYPE_LABELS.RETURN_FREIGHT);
  });
});
