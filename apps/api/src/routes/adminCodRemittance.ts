import { Router } from 'express';
import { codRemittanceImportSchema, codRemittanceMarkSchema, type CodRemittanceOverview } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { awaitingRemittance, importRemittances, markRemitted } from '../services/shipping/codRemittance';

// COD remittance: what Delhivery owes Clowe for delivered COD parcels, its
// remittance reports matched to them, and parcels marked remitted by hand.
export const adminCodRemittanceRouter = Router();
adminCodRemittanceRouter.use(requireAuth, requireRole('ADMIN'));

adminCodRemittanceRouter.get('/', async (_req, res, next) => {
  try {
    const [awaiting, imports] = await Promise.all([
      awaitingRemittance(),
      prisma.codRemittanceImport.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    const body: CodRemittanceOverview = {
      awaiting,
      awaitingTotalPaise: awaiting.reduce((sum, a) => sum + a.codAmountPaise, 0),
      imports: imports.map((i) => ({
        id: i.id,
        fileName: i.fileName,
        rowCount: i.rowCount,
        matched: i.matched,
        mismatched: i.mismatched,
        unknown: i.unknown,
        duplicate: i.duplicate,
        createdAt: i.createdAt.toISOString(),
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

adminCodRemittanceRouter.post('/import', async (req, res, next) => {
  try {
    const input = codRemittanceImportSchema.parse(req.body);
    const result = await importRemittances(input.csv, req.auth!.userId, input.fileName ?? null);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

adminCodRemittanceRouter.post('/parcels/:shipmentId/mark', async (req, res, next) => {
  try {
    const { reference } = codRemittanceMarkSchema.parse(req.body);
    await markRemitted(req.params.shipmentId, reference);
    res.json({ success: true, data: { shipmentId: req.params.shipmentId } });
  } catch (err) {
    next(err);
  }
});
