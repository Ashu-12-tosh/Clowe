/**
 * One-off: the final LIVE Delhivery test before switching shipping on — one
 * prepaid booking from the owner's test warehouse CLW-TEST-LIVE, its label,
 * and its cancellation. Never a pickup request, never COD.
 *
 *   dc exec -e DLV_TOKEN="$DELHIVERY_PRODUCTION_TOKEN" api npx tsx prisma/delhiveryLiveTest.ts            # dry run
 *   dc exec -e DLV_TOKEN="$DELHIVERY_PRODUCTION_TOKEN" api npx tsx prisma/delhiveryLiveTest.ts --apply    # book, label, cancel
 *
 * The token reaches this process only (DLV_TOKEN) and is never printed.
 * Dry run: read-only calls on live Delhivery (serviceability of both PIN
 * codes and the freight rate), plus the exact booking it would make.
 * --apply (only after the owner's yes): books it, reads the label, cancels it
 * at once (before any pickup, so it tracks "Not Picked"), and reads tracking.
 */
import fs from 'node:fs';
import { DelhiveryShippingProvider } from '../src/services/shipping/DelhiveryShippingProvider';
import type { CreateShipmentRequest } from '../src/services/shipping/ShippingProvider';

const apply = process.argv.includes('--apply');
const token = process.env.DLV_TOKEN ?? '';
const ORIGIN = '110073'; // CLW-TEST-LIVE, Najafgarh
const DESTINATION = '110053';
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const reference = `CLW-LIVETEST-${stamp}`;

const request: CreateShipmentRequest = {
  reference,
  orderNumber: reference,
  pickup: { warehouseName: 'CLW-TEST-LIVE', pincode: ORIGIN },
  consignee: {
    name: 'Clowe Live Test',
    phone: '8929316316',
    line1: 'Live booking test - cancelled before pickup, do not deliver',
    line2: null,
    city: 'Delhi',
    state: 'Delhi',
    pincode: DESTINATION,
  },
  payment: 'PREPAID',
  codAmountPaise: 0,
  invoiceValuePaise: 10_000,
  mode: 'SURFACE',
  weightGrams: 500,
  lengthMm: 200,
  widthMm: 150,
  heightMm: 100,
  products: [{ title: 'Test parcel (not shipped)', quantity: 1, hsn: null, gstRatePercent: 18 }],
  sellerGstin: '07AAWFC9519L1ZL',
};

async function main() {
  if (!/^[0-9a-f]{40}$/i.test(token)) throw new Error('DLV_TOKEN is missing or not a Delhivery token — refusing');
  const writes: string[] = [];
  const provider = new DelhiveryShippingProvider({
    token,
    environment: 'production',
    allowProductionWrites: apply,
    log: (line) => writes.push(line),
  });

  console.log(`[dlv-live] ${apply ? 'APPLY' : 'Dry run'} on live Delhivery (track.delhivery.com); writes ${apply ? 'ON for this process only' : 'refused'}`);
  for (const pin of [ORIGIN, DESTINATION]) {
    const s = await provider.checkPincode(pin);
    console.log(`[dlv-live] ${pin}: serviceable ${s.serviceable}, prepaid ${s.prepaid}, pickup ${s.pickup}, cod ${s.cod}`);
  }
  const q = await provider.quote({ originPincode: ORIGIN, destinationPincode: DESTINATION, mode: 'SURFACE', weightGrams: 500, kind: 'DELIVERED', payment: 'PREPAID' });
  console.log(`[dlv-live] rate ${ORIGIN} → ${DESTINATION}, 0.5 kg prepaid surface: zone ${q.zone}, ₹${(q.totalPaise / 100).toFixed(2)} incl. GST`);
  console.log(`[dlv-live] booking: ${reference}, PREPAID, ₹100 invoice, 0.5 kg, 20x15x10 cm, from CLW-TEST-LIVE to ${DESTINATION}; then label, then cancel. No pickup request.`);
  if (!apply) {
    console.log('[dlv-live] Dry run: nothing booked. Run again with --apply after the owner says yes.');
    return;
  }

  const shipment = await provider.createShipment(request);
  console.log(`[dlv-live] BOOKED: AWB ${shipment.awbNumber} (${shipment.courierName}), estimate ${shipment.estimatedFreightPaise != null ? `₹${(shipment.estimatedFreightPaise / 100).toFixed(2)}` : 'n/a'}`);
  try {
    const label = await provider.getLabel(shipment.awbNumber);
    console.log(`[dlv-live] label: barcode ${label.barcodeValue}, sort code ${label.sortCode ?? '—'}, hub ${label.destinationHub ?? '—'}`);
    fs.writeFileSync(`/tmp/dlv-live-label-${shipment.awbNumber}.json`, JSON.stringify(label, null, 2));
  } finally {
    // Cancelled whatever the label did: nothing may stay booked.
    await provider.cancelShipment(shipment.awbNumber);
    console.log(`[dlv-live] CANCELLED: ${shipment.awbNumber}`);
  }
  const [t] = await provider.track([shipment.awbNumber]);
  console.log(`[dlv-live] tracking now: ${t ? `${t.status} — ${t.statusText ?? ''}` : 'no answer yet'}`);
  console.log(`[dlv-live] writes made: ${writes.length}`);
  for (const w of writes) console.log(`[dlv-live]   ${w}`);
}

main().catch((e) => {
  console.error('[dlv-live]', e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exitCode = 1;
});
