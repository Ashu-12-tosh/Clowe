-- Order tracking bar: when Delhivery was last asked about a parcel (the
-- buyer's Refresh is limited to one call per AWB per 10 minutes), and who
-- cancelled a line and when.
ALTER TABLE "shipments" ADD COLUMN "trackedAt" TIMESTAMP(3);
ALTER TABLE "order_items" ADD COLUMN "cancelledBy" TEXT;
ALTER TABLE "order_items" ADD COLUMN "cancelledAt" TIMESTAMP(3);
