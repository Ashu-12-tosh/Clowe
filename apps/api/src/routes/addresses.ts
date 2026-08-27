import { Router } from 'express';
import type { Address } from '@prisma/client';
import { addressUpsertSchema, type AddressInfo } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';

export const addressesRouter = Router();
addressesRouter.use(requireAuth);

/** Shared with the account dashboard. */
export function toAddressInfo(a: Address): AddressInfo {
  return {
    id: a.id,
    label: a.label,
    name: a.name,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    landmark: a.landmark,
    city: a.city,
    state: a.state,
    pincode: a.pincode,
    isDefault: a.isDefault,
  };
}

addressesRouter.get('/', async (req, res, next) => {
  try {
    const addresses = await prisma.address.findMany({
      where: { userId: req.auth!.userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, data: addresses.map(toAddressInfo) });
  } catch (err) {
    next(err);
  }
});

addressesRouter.post('/', async (req, res, next) => {
  try {
    const input = addressUpsertSchema.parse(req.body);
    const count = await prisma.address.count({ where: { userId: req.auth!.userId } });
    const makeDefault = input.isDefault ?? count === 0; // first address is default
    if (makeDefault) {
      await prisma.address.updateMany({
        where: { userId: req.auth!.userId },
        data: { isDefault: false },
      });
    }
    const address = await prisma.address.create({
      data: { ...input, isDefault: makeDefault, userId: req.auth!.userId },
    });
    res.json({ success: true, data: toAddressInfo(address) });
  } catch (err) {
    next(err);
  }
});

addressesRouter.put('/:id', async (req, res, next) => {
  try {
    const input = addressUpsertSchema.parse(req.body);
    const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.auth!.userId) throw ApiError.notFound('Address not found');
    if (input.isDefault) {
      await prisma.address.updateMany({
        where: { userId: req.auth!.userId },
        data: { isDefault: false },
      });
    }
    const address = await prisma.address.update({
      where: { id: existing.id },
      data: { ...input, isDefault: input.isDefault ?? existing.isDefault },
    });
    res.json({ success: true, data: toAddressInfo(address) });
  } catch (err) {
    next(err);
  }
});

addressesRouter.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.auth!.userId) throw ApiError.notFound('Address not found');
    await prisma.address.delete({ where: { id: existing.id } });
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});
