import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import type { HealthResponse } from '@clowe/shared';
import { corsOrigins } from './env';
import { prisma } from './db';
import { authRouter } from './routes/auth';
import { categoriesRouter } from './routes/categories';
import { productsRouter } from './routes/products';
import { searchRouter } from './routes/search';
import { wishlistRouter } from './routes/wishlist';
import { sellerRouter } from './routes/seller';
import { adminRouter } from './routes/admin';
import { cartRouter } from './routes/cart';
import { addressesRouter } from './routes/addresses';
import { ordersRouter } from './routes/orders';
import { paymentsRouter } from './routes/payments';
import { tryonRouter } from './routes/tryon';
import { reviewsRouter } from './routes/reviews';
import { aiRouter } from './routes/ai';
import { notificationsRouter } from './routes/notifications';
import { referralsRouter } from './routes/referrals';
import { trackRouter } from './routes/track';
import { complaintsRouter } from './routes/complaints';
import { settingsRouter } from './routes/settings';
import { deliveryRouter } from './routes/delivery';
import { adsRouter } from './routes/ads';
import { creditsRouter } from './routes/credits';
import { uploadsRouter, uploadDir } from './routes/uploads';
import { homeRouter } from './routes/home';
import { meRouter } from './routes/me';
import { adminContentRouter } from './routes/adminContent';
import { adminTryonRouter } from './routes/adminTryon';
import { adminSellersRouter } from './routes/adminSellers';
import { adminAuditRouter } from './routes/adminAudit';
import { adminSearchRouter } from './routes/adminSearch';
import { adminSupportDeskRouter } from './routes/adminSupportDesk';
import { adminOverviewRouter } from './routes/adminOverview';
import { adminInventoryRouter } from './routes/adminInventory';
import { adminOrdersRouter } from './routes/adminOrders';
import { adminPaymentsRouter } from './routes/adminPayments';
import { adminReturnsRouter } from './routes/adminReturns';
import { sellerDashboardRouter } from './routes/sellerDashboard';
import { sellerOrdersRouter } from './routes/sellerOrders';
import { sellerPayoutsRouter } from './routes/sellerPayouts';
import { sellerProductsRouter } from './routes/sellerProducts';
import { sellerPromotionsRouter } from './routes/sellerPromotions';
import { sellerReturnsRouter } from './routes/sellerReturns';
import { sellerCustomersRouter } from './routes/sellerCustomers';
import { sellerInventoryRouter } from './routes/sellerInventory';
import { sellerSupportRouter } from './routes/sellerSupport';
import { sellerStoreRouter } from './routes/sellerStore';
import { sellerTryonRouter } from './routes/sellerTryon';
import { sellerKycRouter } from './routes/sellerKyc';
import { storesRouter } from './routes/stores';
import { adminSupportRouter } from './routes/adminSupport';
import { errorHandler } from './middleware/error';
import { globalLimiter } from './middleware/rateLimits';
import { auditLogger } from './middleware/audit';

export function createApp() {
  const app = express();

  // Behind Nginx in production — trust the first proxy hop so req.ip and
  // rate limiting see the real client IP, not the proxy's.
  app.set('trust proxy', 1);

  // crossOriginResourcePolicy relaxed so the web app (port 3000) can embed
  // uploaded images served from this API (port 4000).
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use('/api', globalLimiter);
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(cookieParser());
  // Keep the raw body around for webhook signature verification (Razorpay).
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );

  // Audit every state-changing API call, before the routes see it. Mounted at
  // the root so req.path keeps its /api prefix for the route rules.
  app.use(auditLogger);

  // Uploaded product images (local disk in dev).
  app.use('/uploads', express.static(uploadDir, { maxAge: '7d', immutable: true }));

  // Health check: reports API liveness and database reachability.
  app.get('/api/health', async (_req, res) => {
    let database: HealthResponse['database'] = 'down';
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    const body: HealthResponse = {
      status: 'ok',
      service: 'clowe-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      database,
    };
    res.json({ success: true, data: body });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/home', homeRouter);
  app.use('/api/me', meRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/stores', storesRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/delivery', deliveryRouter);
  app.use('/api/wishlist', wishlistRouter);
  // Mounted before /api/seller so the order-management routes win.
  app.use('/api/seller/dashboard', sellerDashboardRouter);
  app.use('/api/seller/orders', sellerOrdersRouter);
  app.use('/api/seller/payouts', sellerPayoutsRouter);
  // Only the dashboard endpoints live here; product CRUD falls through below.
  app.use('/api/seller/products', sellerProductsRouter);
  app.use('/api/seller/promotions', sellerPromotionsRouter);
  app.use('/api/seller/returns', sellerReturnsRouter);
  app.use('/api/seller/customers', sellerCustomersRouter);
  app.use('/api/seller/inventory', sellerInventoryRouter);
  app.use('/api/seller/support', sellerSupportRouter);
  app.use('/api/seller/store', sellerStoreRouter);
  app.use('/api/seller/tryon', sellerTryonRouter);
  app.use('/api/seller/kyc', sellerKycRouter);
  app.use('/api/seller', sellerRouter);
  // Specific admin routers first — a catch-all /api/admin mount would
  // otherwise answer (or 404) their paths before they are reached.
  app.use('/api/admin/tryon', adminTryonRouter);
  app.use('/api/admin/sellers', adminSellersRouter);
  app.use('/api/admin/audit', adminAuditRouter);
  app.use('/api/admin/search', adminSearchRouter);
  app.use('/api/admin/support-desk', adminSupportDeskRouter);
  app.use('/api/admin/overview', adminOverviewRouter);
  app.use('/api/admin/inventory', adminInventoryRouter);
  app.use('/api/admin/orders', adminOrdersRouter);
  app.use('/api/admin/payments', adminPaymentsRouter);
  app.use('/api/admin/returns', adminReturnsRouter);
  app.use('/api/admin/support', adminSupportRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/admin', adminContentRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api/addresses', addressesRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/tryon', tryonRouter);
  app.use('/api/products/:productId/reviews', reviewsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/referrals', referralsRouter);
  app.use('/api/track', trackRouter);
  app.use('/api/complaints', complaintsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/ads', adsRouter);
  app.use('/api/credits', creditsRouter);
  app.use('/api/uploads', uploadsRouter);

  // 404 for unknown API routes.
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  app.use(errorHandler);

  return app;
}
