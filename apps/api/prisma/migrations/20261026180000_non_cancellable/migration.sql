-- Cancellation Policy 2.1: products marked non-cancellable; the line keeps it.
ALTER TABLE "products" ADD COLUMN "nonCancellable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "order_items" ADD COLUMN "nonCancellable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "cancelReason" TEXT;
