import { describe, expect, it } from 'vitest';
import {
  buildParcelTracking,
  buildReturnTracking,
  cleanLocation,
  describeScan,
  failedAttemptReason,
  summarizeOrderTracking,
  type ParcelTrackingInput,
  type ReturnTrackingInput,
  type TrackScanInput,
  type TrackShipmentInput,
} from './tracking';

// India time: 05:30 UTC is 11:00 IST. "Now" is Mon 2 Nov 2026, 4 PM IST.
const NOW = new Date('2026-11-02T10:30:00Z');
const at = (iso: string) => new Date(iso);
const placed = at('2026-10-29T06:00:00Z');

const scan = (iso: string, statusType: string, status: string, code = '', instructions: string | null = null, location: string | null = 'Pune_Bhosari_H (Maharashtra)'): TrackScanInput => ({
  at: at(iso),
  statusType,
  status,
  code,
  instructions,
  location,
});
const MANIFESTED = scan('2026-10-30T05:00:00Z', 'UD', 'Manifested', 'X-UCI', 'Consignment Manifested');
const PICKED = scan('2026-10-30T12:00:00Z', 'UD', 'In Transit', 'X-PPOM', 'Shipment picked up');
const AT_HUB = scan('2026-10-31T03:00:00Z', 'UD', 'In Transit', 'X-IBD3F', 'Shipment Received at Facility', 'Mumbai_Bhiwandi_HB (Maharashtra)');
const OFD = scan('2026-11-02T03:30:00Z', 'UD', 'Dispatched', 'X-DDD3FD', 'Out for delivery');
const FAILED = scan('2026-11-02T08:00:00Z', 'UD', 'Pending', 'EOD-11', 'Consignee Unavailable');
const DELIVERED = scan('2026-11-02T10:10:00Z', 'DL', 'Delivered', 'EOD-38', 'Delivered to consignee');

function shipment(over: Partial<TrackShipmentInput> = {}): TrackShipmentInput {
  return {
    status: 'IN_TRANSIT',
    createdAt: at('2026-10-30T05:00:00Z'),
    pickupFailedAt: null,
    pickedUpAt: PICKED.at,
    deliveredAt: null,
    rtoInitiatedAt: null,
    rtoDeliveredAt: null,
    cancelledAt: null,
    deliveryAttempts: 0,
    courierPromisedAt: at('2026-11-03T00:00:00Z'),
    etaTo: at('2026-11-04T00:00:00Z'),
    lostFlaggedAt: null,
    lostChoice: null,
    rtoReason: null,
    statusText: null,
    ...over,
  };
}

function input(over: Partial<ParcelTrackingInput> = {}, lineStatus = 'SHIPPED'): ParcelTrackingInput {
  return {
    now: NOW,
    placedAt: placed,
    paymentMethod: 'UPI',
    awaitingPayment: false,
    lines: [
      { status: lineStatus, packedAt: at('2026-10-30T04:00:00Z'), shippedAt: lineStatus === 'SHIPPED' || lineStatus === 'DELIVERED' ? PICKED.at : null, deliveredAt: null, cancelReason: null, cancelledBy: null, cancelledAt: null },
    ],
    shipment: shipment(),
    scans: [MANIFESTED, PICKED, AT_HUB],
    promise: { deliveryBy: at('2026-11-03T00:00:00Z'), deliveryByLatest: null },
    orderEtaTo: null,
    refund: null,
    ...over,
  };
}

const states = (t: { steps: { state: string }[] }) => t.steps.map((s) => s.state).join(' ');

describe('parcel tracking — normal journey', () => {
  it('ordered, not packed yet: the promise date', () => {
    const t = buildParcelTracking(input({ shipment: null, scans: [], lines: [{ status: 'CONFIRMED', packedAt: null, shippedAt: null, deliveredAt: null, cancelReason: null, cancelledBy: null, cancelledAt: null }] }, 'CONFIRMED'));
    expect(t.headline).toBe('Arriving tomorrow');
    expect(t.chip).toBe('Ordered');
    expect(states(t)).toBe('current upcoming upcoming upcoming upcoming');
    expect(t.steps[0]!.at).toBe(placed.toISOString());
  });

  it('booked (manifested): packed is the current step', () => {
    const t = buildParcelTracking(input({ shipment: shipment({ status: 'CREATED', pickedUpAt: null, courierPromisedAt: null }), scans: [MANIFESTED] }, 'PACKED'));
    expect(states(t)).toBe('done current upcoming upcoming upcoming');
    expect(t.chip).toBe('Packed');
    expect(t.scans[0]!.description).toMatch(/label created/);
  });

  it('in transit: "Arriving Tue, 3 Nov"-style headline, Shipped is current, scans newest first with clean places', () => {
    const t = buildParcelTracking(input({ now: at('2026-11-01T06:00:00Z') }));
    expect(t.headline).toBe('Arriving Tue, 3 Nov');
    expect(t.tone).toBe('info');
    expect(states(t)).toBe('done done current upcoming upcoming');
    expect(t.steps[2]!.at).toBe(PICKED.at.toISOString());
    expect(t.scans.map((s) => s.description)).toEqual(['Shipment received at facility', 'Shipment picked up', 'Shipping label created — waiting for the courier to collect it']);
    expect(t.scans[0]!.location).toBe('Mumbai Bhiwandi, Maharashtra');
  });

  it('out for delivery today', () => {
    const t = buildParcelTracking(input({ shipment: shipment({ status: 'OUT_FOR_DELIVERY' }), scans: [MANIFESTED, PICKED, AT_HUB, OFD] }));
    expect(t.headline).toBe('Out for delivery today');
    expect(t.chip).toBe('Out for delivery');
    expect(states(t)).toBe('done done done current upcoming');
    expect(t.steps[3]!.at).toBe(OFD.at.toISOString());
  });

  it('delivered: every step done, with date and time', () => {
    const t = buildParcelTracking(
      input(
        {
          shipment: shipment({ status: 'DELIVERED', deliveredAt: DELIVERED.at }),
          scans: [MANIFESTED, PICKED, AT_HUB, OFD, DELIVERED],
          lines: [{ status: 'DELIVERED', packedAt: at('2026-10-30T04:00:00Z'), shippedAt: PICKED.at, deliveredAt: DELIVERED.at, cancelReason: null, cancelledBy: null, cancelledAt: null }],
        },
        'DELIVERED',
      ),
    );
    expect(t.headline).toBe('Delivered on Mon, 2 Nov, 3:40 PM');
    expect(t.tone).toBe('success');
    expect(states(t)).toBe('done done done done done');
    expect(t.steps.every((s) => s.at)).toBe(true);
    expect(t.exception).toBeNull();
  });
});

describe('parcel tracking — exceptions', () => {
  it('failed attempt: Delhivery\'s reason in simple words and what happens next; not a step', () => {
    const t = buildParcelTracking(input({ shipment: shipment({ status: 'DELIVERY_FAILED', deliveryAttempts: 1 }), scans: [MANIFESTED, PICKED, AT_HUB, OFD, FAILED] }));
    expect(t.headline).toBe('Delivery attempt failed — the courier will try again');
    expect(t.tone).toBe('warning');
    expect(t.exception).toMatchObject({ kind: 'FAILED_ATTEMPT', title: 'Delivery attempt 1 of 3 failed on Mon, 2 Nov, 1:30 PM', detail: 'Nobody was available to receive it.' });
    expect(t.exception!.next).toMatch(/try again/);
    expect(t.steps.map((s) => s.label)).toEqual(['Ordered', 'Packed', 'Shipped', 'Out for delivery', 'Delivered']);
    expect(states(t)).toBe('done done done current upcoming');
    expect(t.scans[0]!.description).toBe('Delivery attempt failed — Nobody was available to receive it');
  });

  it('failed attempt, then delivered next day: delivered, no exception', () => {
    const OFD2 = scan('2026-11-03T03:30:00Z', 'UD', 'Dispatched', 'X-DDD3FD');
    const DL2 = scan('2026-11-03T07:00:00Z', 'DL', 'Delivered', 'EOD-38');
    const t = buildParcelTracking(
      input({
        now: at('2026-11-03T09:00:00Z'),
        shipment: shipment({ status: 'DELIVERED', deliveredAt: DL2.at, deliveryAttempts: 1 }),
        scans: [MANIFESTED, PICKED, AT_HUB, OFD, FAILED, OFD2, DL2],
        lines: [{ status: 'DELIVERED', packedAt: null, shippedAt: PICKED.at, deliveredAt: DL2.at, cancelReason: null, cancelledBy: null, cancelledAt: null }],
      }),
    );
    expect(t.headline).toBe('Delivered on Tue, 3 Nov, 12:30 PM');
    expect(t.exception).toBeNull();
    expect(t.steps[3]!.at).toBe(OFD2.at.toISOString());
    expect(t.scans).toHaveLength(7);
  });

  it('third failed attempt: the parcel goes back, refund promised', () => {
    const t = buildParcelTracking(input({ shipment: shipment({ status: 'DELIVERY_FAILED', deliveryAttempts: 3 }), scans: [OFD, FAILED] }));
    expect(t.headline).toBe('Delivery failed — going back to the seller');
    expect(t.exception!.next).toMatch(/last attempt.*refunded in full/);
  });

  it('refused at the door: says what refusing means', () => {
    const refused = scan('2026-11-02T08:00:00Z', 'UD', 'Pending', 'EOD-6', 'Customer refused to accept');
    const t = buildParcelTracking(input({ shipment: shipment({ status: 'DELIVERY_FAILED', deliveryAttempts: 1 }), scans: [OFD, refused] }));
    expect(t.exception!.detail).toBe('The parcel was refused at the door.');
    expect(t.exception!.next).toMatch(/full refund/);
  });

  it('delayed: Delhivery moved its date past the promise', () => {
    const t = buildParcelTracking(input({ shipment: shipment({ courierPromisedAt: at('2026-11-05T00:00:00Z') }) }));
    expect(t.headline).toBe('Delayed — new expected date Thu, 5 Nov');
    expect(t.chip).toBe('Delayed');
    expect(t.tone).toBe('warning');
    expect(t.exception).toMatchObject({ kind: 'DELAYED' });
    expect(t.exception!.detail).toMatch(/due by Tue, 3 Nov/);
  });

  it('delayed: the promised day has gone by', () => {
    const t = buildParcelTracking(input({ now: at('2026-11-04T08:00:00Z') }));
    expect(t.headline).toBe('Delayed — it was due Tue, 3 Nov');
    expect(t.exception!.kind).toBe('DELAYED');
  });

  it('held at a hub', () => {
    const held = scan('2026-11-01T05:00:00Z', 'UD', 'Pending', 'ST-108', 'Shipment held due to regulatory checks', 'Nagpur_Hub (Maharashtra)');
    const t = buildParcelTracking(input({ now: at('2026-11-01T08:00:00Z'), scans: [MANIFESTED, PICKED, held] }));
    expect(t.exception).toMatchObject({ kind: 'HELD', title: 'Held by the courier' });
    expect(t.exception!.detail).toMatch(/Shipment held due to regulatory checks \(Nagpur, Maharashtra\)/);
    expect(t.headline).toBe('Arriving Tue, 3 Nov');
  });

  it('RTO: going back to the seller, the reason and the refund', () => {
    const rto = scan('2026-11-03T05:00:00Z', 'RT', 'In Transit', 'RT-101', 'Consignee refused');
    const t = buildParcelTracking(
      input({
        now: at('2026-11-03T08:00:00Z'),
        shipment: shipment({ status: 'RTO_IN_TRANSIT', rtoInitiatedAt: rto.at, rtoReason: 'Customer refused to accept', deliveryAttempts: 1 }),
        scans: [MANIFESTED, PICKED, OFD, FAILED, rto],
        lines: [{ status: 'RTO_IN_TRANSIT', packedAt: null, shippedAt: PICKED.at, deliveredAt: null, cancelReason: null, cancelledBy: null, cancelledAt: null }],
        refund: { status: 'PROCESSING', amountPaise: 129_900, processedAt: null },
      }),
    );
    expect(t.headline).toBe("Couldn't be delivered — going back to the seller");
    expect(t.tone).toBe('danger');
    expect(t.exception).toMatchObject({ kind: 'RTO', title: 'On its way back to the seller' });
    expect(t.exception!.detail).toBe('The parcel was refused at the door. Your refund of ₹1,299 is on its way (usually 5–7 working days).');
    // Stopped: no step is "current", Delivered never reached.
    expect(states(t)).toBe('done done done done upcoming');
    expect(t.expectedAt).toBeNull();
    expect(t.scans[0]!.description).toBe('Returning to the seller — Consignee refused');
  });

  it('RTO delivered, COD: nothing due', () => {
    const t = buildParcelTracking(
      input({
        paymentMethod: 'COD',
        shipment: shipment({ status: 'RTO_DELIVERED' }),
        lines: [{ status: 'RTO_DELIVERED', packedAt: null, shippedAt: PICKED.at, deliveredAt: null, cancelReason: null, cancelledBy: null, cancelledAt: null }],
      }),
    );
    expect(t.headline).toBe("Couldn't be delivered — returned to the seller");
    expect(t.exception!.detail).toMatch(/Nothing is due from you/);
  });

  it('cancelled by the buyer before shipping: refund status, no expected date', () => {
    const t = buildParcelTracking(
      input({
        shipment: null,
        scans: [],
        lines: [{ status: 'CANCELLED', packedAt: null, shippedAt: null, deliveredAt: null, cancelReason: null, cancelledBy: 'CUSTOMER', cancelledAt: at('2026-10-29T08:00:00Z') }],
        refund: { status: 'PROCESSED', amountPaise: 50_000, processedAt: at('2026-10-30T08:00:00Z') },
      }),
    );
    expect(t.headline).toBe('Cancelled on Thu, 29 Oct');
    expect(t.tone).toBe('muted');
    expect(t.exception).toMatchObject({ kind: 'CANCELLED', title: 'You cancelled this' });
    expect(t.exception!.detail).toBe('Refund of ₹500 issued on Fri, 30 Oct. Your bank may take 5–7 working days to show it.');
    expect(t.expectedAt).toBeNull();
    expect(states(t)).toBe('done upcoming upcoming upcoming upcoming');
  });

  it('cancelled by the seller, with the reason', () => {
    const t = buildParcelTracking(
      input({
        shipment: null,
        scans: [],
        lines: [{ status: 'CANCELLED', packedAt: null, shippedAt: null, deliveredAt: null, cancelReason: 'Out of stock or discontinued', cancelledBy: 'SELLER', cancelledAt: NOW }],
      }),
    );
    expect(t.exception!.title).toBe('Cancelled by the seller');
    expect(t.exception!.detail).toMatch(/^Reason: Out of stock or discontinued\. Anything you paid/);
  });

  it('cancelled by Clowe', () => {
    const t = buildParcelTracking(
      input({ shipment: null, scans: [], lines: [{ status: 'CANCELLED', packedAt: null, shippedAt: null, deliveredAt: null, cancelReason: 'Address not serviceable', cancelledBy: 'ADMIN', cancelledAt: NOW }] }),
    );
    expect(t.exception!.title).toBe('Cancelled by Clowe');
  });

  it('lost: the buyer chooses, then sees the outcome', () => {
    const lostScan = scan('2026-11-02T05:00:00Z', 'UD', 'Lost', 'LT-100');
    const t = buildParcelTracking(input({ shipment: shipment({ status: 'LOST', lostFlaggedAt: lostScan.at }), scans: [PICKED, lostScan] }));
    expect(t.headline).toBe('Lost in transit');
    expect(t.exception).toMatchObject({ kind: 'LOST' });
    expect(t.exception!.detail).toMatch(/Choose a free replacement or a full refund/);
    expect(t.scans[0]!.description).toBe('Reported lost by the courier');
    const chosen = buildParcelTracking(input({ shipment: shipment({ status: 'LOST', lostFlaggedAt: lostScan.at, lostChoice: 'REPLACEMENT' }) }));
    expect(chosen.exception!.detail).toMatch(/replacement is on its way/);
  });

  it('lost, after the buyer chose a refund: still "Lost", not "Cancelled", though its lines are closed', () => {
    const t = buildParcelTracking(
      input({
        shipment: shipment({ status: 'LOST', lostFlaggedAt: NOW, lostChoice: 'REFUND' }),
        lines: [{ status: 'CANCELLED', packedAt: null, shippedAt: PICKED.at, deliveredAt: null, cancelReason: null, cancelledBy: null, cancelledAt: NOW }],
        refund: { status: 'PROCESSED', amountPaise: 100_000, processedAt: NOW },
      }),
    );
    expect(t.headline).toBe('Lost in transit');
    expect(t.exception!.detail).toMatch(/^Refund of ₹1,000 issued/);
  });

  it('cancelled because the payment failed', () => {
    const t = buildParcelTracking(
      input({ shipment: null, scans: [], lines: [{ status: 'CANCELLED', packedAt: null, shippedAt: null, deliveredAt: null, cancelReason: null, cancelledBy: 'PAYMENT_FAILED', cancelledAt: NOW }] }),
    );
    expect(t.exception).toMatchObject({ title: "Cancelled — the payment didn't go through" });
    expect(t.exception!.detail).toMatch(/Nothing was charged/);
  });

  it('the courier missed the pickup', () => {
    const t = buildParcelTracking(input({ shipment: shipment({ status: 'PICKUP_REQUESTED', pickedUpAt: null, pickupFailedAt: NOW, courierPromisedAt: null }), scans: [MANIFESTED] }, 'PACKED'));
    expect(t.exception).toMatchObject({ kind: 'NOT_PICKED' });
  });

  it('a booking cancelled while the line lives on is ignored (rebooked next)', () => {
    const t = buildParcelTracking(input({ shipment: shipment({ status: 'CANCELLED', pickedUpAt: null }), scans: [] }, 'PACKED'));
    expect(t.chip).toBe('Packed');
    expect(t.exception).toBeNull();
  });

  it('awaiting payment', () => {
    const t = buildParcelTracking(input({ awaitingPayment: true, shipment: null, scans: [] }, 'PLACED'));
    expect(t.headline).toBe('Waiting for your payment');
  });
});

describe('scan words', () => {
  it('failed-attempt reasons in simple words, by words first and code second', () => {
    expect(failedAttemptReason({ code: 'EOD-74', instructions: null, status: 'Pending' })).toBe("The courier couldn't find the address");
    expect(failedAttemptReason({ code: 'EOD-999', instructions: 'Incomplete address & contact details', status: 'Pending' })).toBe("The courier couldn't find the address");
    expect(failedAttemptReason({ code: 'EOD-999', instructions: 'CUSTOMER ASKED FOR FUTURE DELIVERY', status: 'Pending' })).toBe('You asked for delivery on another day');
    expect(failedAttemptReason({ code: 'EOD-999', instructions: null, status: 'Pending' })).toBe("The courier couldn't deliver it");
  });

  it('never repeats a phone number from the courier\'s words', () => {
    expect(describeScan(scan('2026-11-01T00:00:00Z', 'UD', 'In Transit', '', 'Call 9876543210 for details'))).toBe('Call for details');
  });

  it('places without hub codes', () => {
    expect(cleanLocation('Pune_Bhosari_H (Maharashtra)')).toBe('Pune Bhosari, Maharashtra');
    expect(cleanLocation('Delhi_Bilaspur_GW (Haryana)')).toBe('Delhi Bilaspur, Haryana');
    expect(cleanLocation(null)).toBeNull();
  });

  it('reverse and RTO scans', () => {
    expect(describeScan(scan('2026-11-01T00:00:00Z', 'PP', 'Open', 'X-PPONM'))).toBe('Return pickup scheduled');
    expect(describeScan(scan('2026-11-01T00:00:00Z', 'PU', 'In Transit', 'X-PU'))).toMatch(/Return picked up/);
    expect(describeScan(scan('2026-11-01T00:00:00Z', 'DL', 'DTO', 'X-DTO'))).toBe('Return delivered to the seller');
    expect(describeScan(scan('2026-11-01T00:00:00Z', 'DL', 'RTO', 'RT-110'))).toBe('Returned to the seller');
    expect(describeScan(scan('2026-11-01T00:00:00Z', 'CN', 'Canceled', 'X-CNCL'))).toBe('Shipment cancelled');
  });
});

describe('return tracking', () => {
  function ret(over: Partial<ReturnTrackingInput> = {}): ReturnTrackingInput {
    return {
      returnId: 'r1',
      itemTitle: 'Kettle',
      rmaNumber: 'RMA-2026-000001',
      now: NOW,
      status: 'REQUESTED',
      createdAt: at('2026-11-01T05:00:00Z'),
      approvedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      pickedUpAt: null,
      receivedAt: null,
      resolution: 'REFUND',
      remedy: 'REFUND',
      selfShip: false,
      pickup: null,
      pickupScans: [],
      refund: null,
      exchangeShippedAt: null,
      paymentMethod: 'UPI',
      ...over,
    };
  }
  const pickup = { status: 'PICKUP_REQUESTED', createdAt: at('2026-11-01T08:00:00Z'), pickedUpAt: null, deliveredAt: null, pickupFailedAt: null };

  it('requested → pickup scheduled → picked up → received → refund issued', () => {
    expect(buildReturnTracking(ret()).headline).toMatch(/Return requested/);
    const scheduled = buildReturnTracking(ret({ status: 'APPROVED', approvedAt: pickup.createdAt, pickup }));
    expect(scheduled.chip).toBe('Pickup scheduled');
    expect(states(scheduled)).toBe('done current upcoming upcoming upcoming');
    const picked = buildReturnTracking(ret({ status: 'APPROVED', pickup: { ...pickup, pickedUpAt: at('2026-11-02T05:00:00Z') }, pickupScans: [scan('2026-11-02T05:00:00Z', 'PU', 'In Transit', 'X-PU')] }));
    expect(picked.headline).toBe('Return picked up — on its way to the seller');
    expect(picked.scans).toHaveLength(1);
    const received = buildReturnTracking(ret({ status: 'RECEIVED', pickup: { ...pickup, pickedUpAt: NOW, deliveredAt: NOW }, receivedAt: NOW }));
    expect(states(received)).toBe('done done done current upcoming');
    const refunded = buildReturnTracking(
      ret({ status: 'REFUNDED', pickup: { ...pickup, pickedUpAt: NOW, deliveredAt: NOW }, receivedAt: NOW, refund: { status: 'PROCESSED', amountPaise: 1000, processedAt: at('2026-11-03T05:00:00Z') } }),
    );
    expect(refunded.headline).toBe('Refund issued on Tue, 3 Nov');
    expect(refunded.steps.map((s) => s.label)).toEqual(['Return requested', 'Pickup scheduled', 'Picked up', 'Received by seller', 'Refund issued']);
    expect(states(refunded)).toBe('done done done done done');
  });

  it('exchange: the last step is the exchange shipping', () => {
    const t = buildReturnTracking(ret({ status: 'RECEIVED', remedy: 'EXCHANGE', resolution: 'EXCHANGE', pickup: { ...pickup, pickedUpAt: NOW, deliveredAt: NOW }, receivedAt: NOW, exchangeShippedAt: at('2026-11-03T05:00:00Z') }));
    expect(t.steps[4]!.label).toBe('Exchange shipped');
    expect(t.headline).toBe('Exchange shipped on Tue, 3 Nov');
  });

  it('rejected: shown as its own box', () => {
    const t = buildReturnTracking(ret({ status: 'REJECTED', rejectedAt: NOW, rejectionReason: 'Item used' }));
    expect(t.exception).toMatchObject({ kind: 'RETURN_REJECTED', detail: 'Reason: Item used.' });
  });

  it('pickup failed', () => {
    const t = buildReturnTracking(ret({ status: 'APPROVED', pickup: { ...pickup, pickupFailedAt: NOW } }));
    expect(t.exception!.kind).toBe('PICKUP_FAILED');
  });
});

describe('order summary', () => {
  it('the parcel needing attention leads; delivered count when mixed', () => {
    const s = summarizeOrderTracking([
      { chip: 'Delivered', headline: 'Delivered on Mon, 2 Nov, 3:40 PM', tone: 'success', expectedAt: null },
      { chip: 'Arriving', headline: 'Arriving Tue, 3 Nov', tone: 'info', expectedAt: '2026-11-03T00:00:00.000Z' },
    ]);
    expect(s).toEqual({ chip: 'Arriving', headline: 'Arriving Tue, 3 Nov · 1 of 2 parcels delivered', tone: 'info' });
    expect(summarizeOrderTracking([])).toBeNull();
  });
});
