import { describe, expect, it } from 'vitest';
import { aggregateStatus } from './orderStatusService';

const lines = (...statuses: string[]) => statuses.map((status) => ({ status }));

describe('aggregateStatus with undelivered (RTO) lines', () => {
  it('an order whose only parcel is coming back is RTO_IN_TRANSIT, then RTO_DELIVERED', () => {
    expect(aggregateStatus(lines('RTO_IN_TRANSIT'))).toEqual({ status: 'RTO_IN_TRANSIT', mixed: false });
    expect(aggregateStatus(lines('RTO_DELIVERED'))).toEqual({ status: 'RTO_DELIVERED', mixed: false });
  });

  it('work still open on another line is what the order shows', () => {
    expect(aggregateStatus(lines('SHIPPED', 'RTO_IN_TRANSIT'))).toEqual({ status: 'SHIPPED', mixed: true });
    expect(aggregateStatus(lines('CONFIRMED', 'RTO_DELIVERED'))).toEqual({ status: 'CONFIRMED', mixed: true });
  });

  it('a delivered line beside one coming back shows the delivered stage, and a finished RTO is like a return', () => {
    expect(aggregateStatus(lines('DELIVERED', 'RTO_IN_TRANSIT'))).toEqual({ status: 'DELIVERED', mixed: true });
    expect(aggregateStatus(lines('DELIVERED', 'RTO_DELIVERED'))).toEqual({ status: 'DELIVERED', mixed: true });
    expect(aggregateStatus(lines('CANCELLED', 'RTO_DELIVERED'))).toEqual({ status: 'RTO_DELIVERED', mixed: true });
    expect(aggregateStatus(lines('RETURNED', 'RTO_DELIVERED'))).toEqual({ status: 'RETURNED', mixed: true });
  });

  it('leaves orders without RTO exactly as before', () => {
    expect(aggregateStatus(lines('CANCELLED', 'CANCELLED'))).toEqual({ status: 'CANCELLED', mixed: false });
    expect(aggregateStatus(lines('PACKED', 'SHIPPED'))).toEqual({ status: 'PACKED', mixed: true });
    expect(aggregateStatus(lines('DELIVERED', 'RETURN_REQUESTED'))).toEqual({ status: 'RETURN_REQUESTED', mixed: true });
  });
});
