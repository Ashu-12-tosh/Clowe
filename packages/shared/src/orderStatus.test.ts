import { describe, expect, it } from 'vitest';
import { isNotASale, NOT_A_SALE_STATUSES } from './orderStatus';

describe('isNotASale', () => {
  it('excludes cancelled, returned and undelivered (RTO) lines from sales', () => {
    for (const s of ['CANCELLED', 'RETURNED', 'RTO_IN_TRANSIT', 'RTO_DELIVERED']) expect(isNotASale(s), s).toBe(true);
    expect(NOT_A_SALE_STATUSES).toHaveLength(4);
  });

  it('counts everything on its way to, or with, the buyer', () => {
    for (const s of ['PLACED', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURN_REQUESTED']) expect(isNotASale(s), s).toBe(false);
  });
});
