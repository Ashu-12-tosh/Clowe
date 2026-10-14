import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { ADMIN_SHIPMENT_FILTERS, type AdminShipmentPage } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { shippingProvider } from '../services/shipping';

// Every parcel with the courier, for the operations desk: what needs someone
// (failed attempts, lost parcels, coming back, waiting too long for pickup),
// and everything else by status. Refresh and NDR actions live on the order
// routes (/api/admin/orders/shipments/:id/...).
export const adminShipmentsRouter = Router();
adminShipmentsRouter.use(requireAuth, requireRole('ADMIN'));

const query = z.object({
  filter: z.enum(ADMIN_SHIPMENT_FILTERS).default('ATTENTION'),
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});

/** Booked or asked for pickup more than two days ago and still not collected. */
const STALE_MS = 2 * 86_400_000;

adminShipmentsRouter.get('/', async (req, res, next) => {
  try {
    const input = query.parse(req.query);
    const stale = new Date(Date.now() - STALE_MS);
    const byFilter: Record<(typeof ADMIN_SHIPMENT_FILTERS)[number], Prisma.ShipmentWhereInput> = {
      ATTENTION: {
        OR: [
          { status: { in: ['DELIVERY_FAILED', 'LOST', 'RTO_IN_TRANSIT'] } },
          { status: 'RTO_DELIVERED', rtoReceivedAt: null },
          { status: { in: ['CREATED', 'PICKUP_REQUESTED'] }, createdAt: { lt: stale } },
        ],
      },
      AWAITING_PICKUP: { status: { in: ['CREATED', 'PICKUP_REQUESTED'] } },
      IN_TRANSIT: { status: { in: ['IN_TRANSIT', 'OUT_FOR_DELIVERY'] } },
      DELIVERED: { status: 'DELIVERED' },
      RTO: { status: { in: ['RTO_IN_TRANSIT', 'RTO_DELIVERED'] } },
      CANCELLED: { status: { in: ['CANCELLED', 'LOST'] } },
      ALL: {},
    };
    const where: Prisma.ShipmentWhereInput = {
      ...byFilter[input.filter],
      ...(input.q
        ? {
            AND: [
              {
                OR: [
                  { awbNumber: { contains: input.q, mode: 'insensitive' } },
                  { order: { orderNumber: { contains: input.q, mode: 'insensitive' } } },
                  { seller: { shopName: { contains: input.q, mode: 'insensitive' } } },
                ],
              },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.shipment.count({ where }),
      prisma.shipment.findMany({
        where,
        orderBy: [{ lastScanAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        include: { order: { select: { id: true, orderNumber: true } }, seller: { select: { shopName: true } } },
      }),
    ]);
    const body: AdminShipmentPage = {
      provider: shippingProvider.name,
      environment: shippingProvider.environment,
      total,
      page: input.page,
      pageSize: input.pageSize,
      rows: rows.map((s) => ({
        id: s.id,
        kind: s.kind,
        awbNumber: s.awbNumber,
        orderId: s.order.id,
        orderNumber: s.order.orderNumber,
        shopName: s.seller.shopName,
        status: s.status,
        statusText: s.statusText,
        paymentType: s.paymentType,
        codAmountPaise: s.codAmountPaise,
        lastScanAt: s.lastScanAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
        ndrAction: s.ndrAction,
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
