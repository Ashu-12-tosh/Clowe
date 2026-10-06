import type { NextFunction, Request, Response } from 'express';
import { getSettings } from '../services/settingsService';
import { MENTIONS_STOCK, withoutStockPhotos } from '../services/stockPhotos';

const STAFF_ROUTES = /^\/api\/(admin|seller)(\/|\?|$)/;

/**
 * No shopper-facing answer carries a stock photo while the demo catalog is
 * off (PlatformSettings.demoCatalogEnabled).
 *
 * Hiding the demo store already keeps its products out; this is the backstop
 * for everything else seeded with one — home banners, promo tiles, category
 * images and banners — and for whatever else still points at one, such as a
 * past order of a demo product. The stored rows are untouched: the page shows
 * its designed no-image version until a real image is uploaded in admin, and
 * turning the demo catalog on restores them all. Admin and seller screens
 * are left as they are.
 *
 * Only an answer that mentions a stock host is looked at further, so the
 * setting is read for those alone. If it cannot be read, the photos are
 * stripped: the safe answer is the one without them.
 */
export function stockPhotoGuard(req: Request, res: Response, next: NextFunction) {
  if (STAFF_ROUTES.test(req.originalUrl)) return next();
  const send = res.json.bind(res);
  res.json = (body: unknown) => {
    const text = JSON.stringify(body);
    if (text === undefined || !MENTIONS_STOCK.test(text)) return send(body);
    getSettings()
      .then((s) => s.demoCatalogEnabled)
      .catch(() => false)
      .then((demoShown) => send(demoShown ? body : withoutStockPhotos(JSON.parse(text))));
    return res;
  };
  next();
}
