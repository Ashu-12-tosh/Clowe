import { Router } from 'express';
import { getPublicSettings } from '../services/settingsService';

export const settingsRouter = Router();

// Public, cache-friendly subset (try-on threshold, footer social links).
settingsRouter.get('/public', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getPublicSettings() });
  } catch (err) {
    next(err);
  }
});
