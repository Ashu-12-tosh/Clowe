import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  deliveryZoneFor,
  dispatchedEtaWindow,
  isPoBoxAddress,
  orderEtaWindow,
} from './deliveryZone';
import { addressUpsertSchema } from './checkout';

// Noon in India on a Monday, 19 Oct 2026.
const MONDAY_NOON_IST = new Date('2026-10-19T06:30:00Z');
const istDay = (d: Date) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

describe('delivery zones (Shipping Policy 3.2)', () => {
  it('puts the metros, the remote list and everything else where the policy does', () => {
    expect(deliveryZoneFor('110073')).toBe('METRO'); // Delhi
    expect(deliveryZoneFor('400001')).toBe('METRO'); // Mumbai
    expect(deliveryZoneFor('560001')).toBe('METRO'); // Bengaluru
    expect(deliveryZoneFor('781001')).toBe('REMOTE'); // Guwahati, North-East
    expect(deliveryZoneFor('737101')).toBe('REMOTE'); // Gangtok, Sikkim
    expect(deliveryZoneFor('190001')).toBe('REMOTE'); // Srinagar, J&K
    expect(deliveryZoneFor('194101')).toBe('REMOTE'); // Leh, Ladakh
    expect(deliveryZoneFor('744101')).toBe('REMOTE'); // Port Blair
    expect(deliveryZoneFor('682555')).toBe('REMOTE'); // Lakshadweep
    expect(deliveryZoneFor('682001')).toBe('OTHER'); // Kochi is not Lakshadweep
    expect(deliveryZoneFor('302001')).toBe('OTHER'); // Jaipur
  });

  it('counts working days, leaving out Sundays (3.3)', () => {
    // From a Monday: Tuesday to Saturday are five; Sunday is skipped; Monday is the sixth.
    expect(istDay(addWorkingDays(MONDAY_NOON_IST, 6))).toBe('2026-10-26');
    expect(istDay(addWorkingDays(MONDAY_NOON_IST, 5))).toBe('2026-10-24'); // Saturday
  });

  it('quotes processing (1–2) plus transit before the order, transit only after dispatch', () => {
    const metro = orderEtaWindow('110073', MONDAY_NOON_IST);
    expect(istDay(metro.from)).toBe(istDay(addWorkingDays(MONDAY_NOON_IST, 3))); // 1 + 2
    expect(istDay(metro.to)).toBe(istDay(addWorkingDays(MONDAY_NOON_IST, 6))); // 2 + 4
    const remote = orderEtaWindow('781001', MONDAY_NOON_IST);
    expect(istDay(remote.to)).toBe(istDay(addWorkingDays(MONDAY_NOON_IST, 14))); // 2 + 12
    const shipped = dispatchedEtaWindow('302001', MONDAY_NOON_IST);
    expect(istDay(shipped.from)).toBe(istDay(addWorkingDays(MONDAY_NOON_IST, 4)));
    expect(istDay(shipped.to)).toBe(istDay(addWorkingDays(MONDAY_NOON_IST, 7)));
  });
});

describe('no post office boxes (2.3)', () => {
  it('spots a box however it is written', () => {
    for (const line of ['PO Box 1234', 'P.O. Box 77, Andheri', 'p o box no. 5', 'POB 12', 'GPO Box 101', 'Post Box No 9', 'Post Office Box 3']) {
      expect(isPoBoxAddress(line), line).toBe(true);
    }
  });

  it('leaves real addresses alone', () => {
    for (const line of ['Near Post Office, Gandhi Nagar', 'A22, Street No. 21, MD Marg', 'Najafgarh P.O.', 'Plot 4, Pocket B', 'Opp. Post Box Lane']) {
      expect(isPoBoxAddress(line), line).toBe(false);
    }
  });

  it('is refused by the address form', () => {
    const base = { name: 'Asha', phone: '9876543210', city: 'Delhi', state: 'Delhi', pincode: '110073' };
    const bad = addressUpsertSchema.safeParse({ ...base, line1: 'PO Box 55' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['line1']);
    expect(addressUpsertSchema.safeParse({ ...base, line1: '12 Main Road' }).success).toBe(true);
  });
});
