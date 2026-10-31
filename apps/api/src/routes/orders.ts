import { Router } from 'express';
import { z } from 'zod';
import type { OrderStatus } from '@prisma/client';
import {
  promiseLabel,
  optionValuesFromJson,
  ORDER_FILTERS,
  type OrderFilter,
  type OrderListResponse,
  checkoutSchema,
  creditsToPaise,
  CREDIT_VALUE_PAISE,
  returnRequestSchema,
  EMI_MIN_PAISE,
  type CheckoutResult,
  type OrderDetailView,
  type OrderListRow,
  type TaxInvoice,
  codPlatformRefusal,
  INTERCEPT_SUBJECT,
  interceptRequestSchema,
  CLAIM_REASONS,
  CLAIM_REASONS_NON_RETURNABLE,
  claimWindow,
  type OrderDetailItem,
  isNotASale,
  isPoBoxAddress,
  LOST_PARCEL_CHOICES,
  type LostParcelChoice,
  PO_BOX_MESSAGE,
  CLAIM_WINDOW_HOURS,
  type CreditNote,
} from '@clowe/shared';
import { chooseLostOutcome } from '../services/shipping/lostParcels';
import { cancelOrderLines } from '../services/lineCancellation';
import { feeSnapshots } from '../services/commercial';
import { assertCanPlaceOrders, canBuyTestListings, canPlaceOrders } from '../services/storeOpen';
import { exchangeAllowed, raiseClaim, rulesForDelivery } from '../services/returnClaims';
import { raiseComplaint } from '../services/complaintService';
import { scanViews } from './track';
import { orderTracking, ordersTrackingSummary, refreshOrderTracking } from '../services/shipping/trackingView';
import { checkoutLimiter, trackRefreshLimiter } from '../middleware/rateLimits';
import { prisma } from '../db';
import { creditNotesFor } from '../services/creditNotes';
import { buildTaxInvoice } from '../services/taxInvoice';
import { hiddenProductTest } from '../services/shopperVisibility';
import { getSettings } from '../services/settingsService';
import { recordRedemptions } from '../services/promotionService';
import { orderLineReturnWindowDays, saleReturnWindows } from '../services/categoryRules';
import { orderLineReturnable, saleReturnability } from '../services/returnability';
import { encryptCodRefundAccount } from '../services/codRefundCrypto';
import { saleGstRates } from '../services/sellerPricing';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { GatewayError, paymentProvider } from '../services/payments';
import { checkoutPayload, createGatewayOrder } from '../services/payments/gatewaySync';
import { planSplits } from '../services/easySplit';
import { buildCartView } from './cart';
import { deliveryPriceFor, etaWindowFor, isDeliveryMethodAvailable } from '../services/deliveryService';
import { codRefusal, deliveryRefusal, pincodeServiceability } from '../services/shipping/serviceability';
import { orderWindow, promisesFor, recordOrderPromises, undeliverableMessage } from '../services/shipping/deliveryPromises';
import { confirmCodOrder, generateOrderNumber, settlePaymentFailure } from '../services/orderService';
import { CHECKOUT_LOCK_WAIT_MS, checkoutBusy, checkoutFingerprint, openOrderFor, replaceOpenOrders, resumeOrder } from '../services/checkoutDedup';
import { openHoldsFor } from '../services/openOrderHolds';
import { nextRmaNumber } from '../services/returnService';
import { allocateForDispatch, inLockOrder } from '../services/stockService';
import { assertOwnAssets, withPhotoUrls } from '../services/assets';

export const ordersRouter = Router();

/** ₹1,499 or ₹1,499.40, as the shopper sees amounts. */
const rupeeText = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
ordersRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Checkout: cart → order (stock reserved) + gateway order
// ---------------------------------------------------------------------------

// Can this account place an order now? (The store may not be open yet.)
ordersRouter.get('/availability', async (req, res, next) => {
  try {
    res.json({ success: true, data: { open: await canPlaceOrders(req.auth!.userId) } });
  } catch (err) {
    next(err);
  }
});

ordersRouter.post('/checkout', checkoutLimiter, async (req, res, next) => {
  try {
    // Before launch: no orders, COD included, except from admins and test accounts.
    await assertCanPlaceOrders(req.auth!.userId);
    // Sellers/admins can browse the store from their dashboards, but buying
    // is customer-only.
    if (req.auth!.role !== 'CUSTOMER') {
      throw ApiError.forbidden(
        'Seller/admin accounts can view the store but cannot purchase',
        'PURCHASE_CUSTOMER_ONLY',
      );
    }
    const {
      addressId,
      useCredits,
      deliveryMethod,
      isGift,
      giftMessage,
      paymentMethod,
      billingAddressId,
      buyerGstin,
      checkoutKey,
      expectedTotalPaise,
    } = checkoutSchema.parse(req.body);
    const userId = req.auth!.userId;

    if (!isDeliveryMethodAvailable(deliveryMethod)) {
      throw ApiError.badRequest(
        'Only standard delivery is offered — it is free on every order',
        'DELIVERY_UNAVAILABLE',
      );
    }

    const address = await prisma.address.findUnique({ where: { id: addressId } });
    if (!address || address.userId !== userId) throw ApiError.badRequest('Address not found');
    // An address saved before the rule: still no delivery to a post office box.
    if (isPoBoxAddress(address.line1, address.line2)) throw ApiError.badRequest(PO_BOX_MESSAGE, 'PO_BOX_ADDRESS');
    // Delhivery has to deliver there (and, for COD, collect cash there).
    const pincodeCheck = await pincodeServiceability(address.pincode);
    const undeliverable = deliveryRefusal(address.pincode, pincodeCheck);
    if (undeliverable) throw ApiError.badRequest(undeliverable, 'PINCODE_NOT_SERVICEABLE');

    // Billing defaults to the shipping address unless another saved one is picked.
    let billing = address;
    if (billingAddressId && billingAddressId !== addressId) {
      const picked = await prisma.address.findUnique({ where: { id: billingAddressId } });
      if (!picked || picked.userId !== userId) {
        throw ApiError.badRequest('Billing address not found');
      }
      billing = picked;
    }

    const cart = await buildCartView(userId);
    // Only ticked lines are bought; the rest stay in the cart for later.
    const orderLines = cart.lines.filter((l) => l.selected);
    if (orderLines.length === 0) {
      throw ApiError.badRequest('Select at least one item to checkout', 'CART_EMPTY');
    }

    // Re-check stock at checkout time.
    for (const line of orderLines) {
      if (line.stock < line.quantity) {
        throw ApiError.badRequest(
          `"${line.title}" (${line.color}/${line.size}) has only ${line.stock} left`,
          'OUT_OF_STOCK',
        );
      }
    }

    // Variant → seller mapping for order items.
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: orderLines.map((l) => l.variantId) } },
      include: {
        product: {
          select: {
            id: true,
            sellerId: true,
            title: true,
            status: true,
            isVisible: true,
            categoryId: true,
            testOnly: true,
            seller: { select: { status: true, vacationMode: true } },
          },
        },
      },
    });

    // A cart is not a promise. Everything below was checked when the item went
    // in, and the same conditions have to hold when it is paid for: suspending
    // a seller hides their listings, but a cart filled the hour before still
    // pointed at them, so the shop kept taking money after it was stopped. The
    // coupon is re-validated a few lines down for the same reason.
    const isHidden = await hiddenProductTest();
    // Test listings (Product.testOnly) sell only to admin-marked test accounts.
    const testBuyer = variants.some((v) => v.product.testOnly) && (await canBuyTestListings(req.auth!.userId));
    const unsellable = variants.filter(
      (v) =>
        v.retiredAt !== null ||
        v.product.status !== 'APPROVED' ||
        isHidden(v.product) ||
        (v.product.testOnly && !testBuyer) ||
        !v.product.isVisible ||
        v.product.seller.vacationMode ||
        v.product.seller.status !== 'APPROVED',
    );
    if (unsellable.length > 0) {
      throw ApiError.badRequest(
        `${unsellable[0]!.product.title} is no longer available — remove it from your cart to continue.`,
        'ITEM_UNAVAILABLE',
      );
    }

    const sellerByVariant = new Map(variants.map((v) => [v.id, v.product.sellerId]));
    const variantById = new Map(variants.map((v) => [v.id, v]));

    // Each seller's delivery date from their own pickup pincode, and whether
    // Delhivery delivers their parcel here at all. Lines it can't deliver are
    // refused by name; Delhivery not answering refuses nothing.
    const promises = await promisesFor([...new Set(orderLines.map((l) => sellerByVariant.get(l.variantId)!))], address.pincode);
    const cannotReach = new Set(promises.filter((p) => p.deliverable === false).map((p) => p.sellerId));
    const unreachable = undeliverableMessage(
      address.pincode,
      orderLines.filter((l) => cannotReach.has(sellerByVariant.get(l.variantId)!)).map((l) => l.title),
    );
    if (unreachable) throw ApiError.badRequest(unreachable, 'ITEM_NOT_DELIVERABLE');

    const orderNumber = await generateOrderNumber();
    const subtotalPaise = cart.subtotalPaise;
    // Delivery is free on every order: the seller pays the courier.
    const shippingPaise = deliveryPriceFor();
    const eta = orderWindow(promises) ?? etaWindowFor(deliveryMethod, new Date(), address.pincode);

    // Coupon: re-validated here, so a code that expired between the cart page
    // and payment simply doesn't apply rather than silently under-charging.
    const couponDiscountPaise = cart.couponDiscountPaise;
    const couponCode = cart.coupon?.code ?? null;

    // Optional shopping-credits discount (user's choice at the payment step).
    // Redeemable up to the order value minus ₹1 (gateways need a payable amount).
    let creditsUsed = 0;
    if (useCredits) {
      const me = await prisma.user.findUnique({
        where: { id: userId },
        select: { creditsBalance: true },
      });
      // Credits the buyer's own unpaid order for these items reserved come
      // back to them if that order is replaced, and are the same credits if it
      // is handed back: either way they are this checkout's.
      const held = (await openHoldsFor(userId, orderLines.map((l) => l.variantId))).credits;
      const maxDiscountPaise = Math.max(
        0,
        subtotalPaise + shippingPaise - couponDiscountPaise - 100,
      );
      // A balance below zero (credits taken back after they were spent) is
      // never a discount the other way.
      creditsUsed = Math.max(0, Math.min((me?.creditsBalance ?? 0) + held, Math.floor(maxDiscountPaise / CREDIT_VALUE_PAISE)));
    }
    const discountPaise = creditsToPaise(creditsUsed) + couponDiscountPaise;
    const totalPaise = subtotalPaise + shippingPaise - discountPaise;

    // The shopper pays the amount they were shown, or is asked again: a price
    // raised, a coupon expired or credits spent since the page loaded used to
    // be charged without a word (pre-launch test H5).
    if (expectedTotalPaise !== undefined && expectedTotalPaise !== totalPaise) {
      throw new ApiError(
        409,
        'PRICE_CHANGED',
        `Your total changed from ${rupeeText(expectedTotalPaise)} to ${rupeeText(totalPaise)} since this page loaded. Please check the new price and confirm.`,
        undefined,
        { previousTotalPaise: expectedTotalPaise, totalPaise },
      );
    }

    // Method-specific eligibility, checked server-side so the UI can't skip it.
    if (paymentMethod === 'EMI' && totalPaise < EMI_MIN_PAISE) {
      throw ApiError.badRequest(
        `EMI is available on orders of ₹${EMI_MIN_PAISE / 100} and above`,
        'EMI_NOT_ELIGIBLE',
      );
    }
    if (paymentMethod === 'COD') {
      const s = await getSettings();
      const refused = codPlatformRefusal({ totalPaise, pincode: address.pincode, ...s });
      if (refused) throw ApiError.badRequest(refused, 'COD_NOT_ELIGIBLE');
    }
    if (paymentMethod === 'COD') {
      const noCodHere = codRefusal(address.pincode, totalPaise, pincodeCheck);
      if (noCodHere) throw ApiError.badRequest(noCodHere, 'COD_NOT_ELIGIBLE');
    }
    // Sellers may switch COD off for their own goods in Store Settings.
    if (paymentMethod === 'COD') {
      const noCod = await prisma.sellerProfile.findFirst({
        where: { id: { in: [...new Set(sellerByVariant.values())] }, codEnabled: false },
        select: { shopName: true },
      });
      if (noCod) {
        throw ApiError.badRequest(
          `${noCod.shopName} does not accept Cash on Delivery — please pay online for this order`,
          'COD_NOT_ELIGIBLE',
        );
      }
    }

    // Each line keeps the return window, whether it can be returned at all,
    // and the GST rate it is sold with.
    const windowByProduct = await saleReturnWindows(orderLines.map((l) => l.productId));
    const returnableByProduct = await saleReturnability(orderLines.map((l) => l.productId));
    const gstRates = await saleGstRates(
      orderLines.map((l) => ({ productId: l.productId, unitPaise: l.pricePaise - Math.floor(l.promoDiscountPaise / l.quantity) })),
    );
    // Clowe's fees, fixed for these lines now (new orders only; older lines keep theirs).
    const feesByLine = await feeSnapshots(
      orderLines.map((l) => ({
        productId: l.productId,
        sellerId: sellerByVariant.get(l.variantId)!,
        unitPricePaise: l.pricePaise - Math.floor(l.promoDiscountPaise / l.quantity),
      })),
    );

    // What this order is, to recognise the same checkout coming again from a
    // retry, a refresh or a second tab (services/checkoutDedup).
    const fingerprint = checkoutFingerprint({
      lines: orderLines.map((l) => ({
        variantId: l.variantId,
        quantity: l.quantity,
        unitPaise: l.pricePaise - Math.floor(l.promoDiscountPaise / l.quantity),
      })),
      addressId: address.id,
      billingAddressId: billing.id,
      deliveryMethod,
      isGift: isGift ?? false,
      giftMessage: isGift ? (giftMessage ?? null) : null,
      buyerGstin: buyerGstin || null,
      creditsUsed,
      couponCode,
      totalPaise,
      cod: paymentMethod === 'COD',
    });

    // Create the order and reserve stock atomically. Conditional decrements
    // guard against a concurrent checkout taking the last unit. First, under
    // the buyer's checkout lock, an order already open for these items is
    // handed back (the same checkout) or stopped and cancelled (a changed one).
    let order: Awaited<ReturnType<typeof prisma.order.create>> | null = null;
    const lockDeadline = Date.now() + CHECKOUT_LOCK_WAIT_MS;
    // An earlier unpaid order for these items was cancelled to make way for this one.
    let replacedEarlier = false;
    for (let round = 0; !order; ) {
      if (round === 3) throw checkoutBusy();
      const placed = await prisma.$transaction(async (tx) => {
        const open = await openOrderFor(tx, {
          userId,
          checkoutKey: checkoutKey ?? null,
          fingerprint,
          variantIds: orderLines.map((l) => l.variantId),
        });
        if (open.kind !== 'none') return open;
        // Still what the cart holds? A payment that settled an order for these
        // items a moment ago clears them from the cart; an order must not be
        // placed again from the cart as it was read before that.
        const inCart = await tx.cartItem.findMany({
          where: { cart: { userId }, variantId: { in: orderLines.map((l) => l.variantId) } },
          select: { variantId: true, quantity: true },
        });
        const inCartQty = new Map(inCart.map((c) => [c.variantId, c.quantity]));
        if (orderLines.some((l) => inCartQty.get(l.variantId) !== l.quantity)) {
          throw new ApiError(409, 'CART_CHANGED', 'Your cart changed just now — please check it and try again.');
        }
        // Once-per-account coupons, checked under the buyer's checkout lock so
        // two checkouts at once cannot both use one (pre-launch test H4).
        if (couponCode && couponDiscountPaise > 0) {
          const limited = await tx.coupon.findUnique({ where: { code: couponCode }, select: { perUserLimit: true } });
          if (limited?.perUserLimit != null) {
            const used = await tx.order.count({ where: { userId, couponCode, status: { not: 'CANCELLED' } } });
            if (used >= limited.perUserLimit) {
              throw ApiError.badRequest(`You have already used ${couponCode}`, 'COUPON_INVALID');
            }
          }
        }
        for (const line of inLockOrder(orderLines)) {
          const updated = await tx.productVariant.updateMany({
            where: { id: line.variantId, stock: { gte: line.quantity } },
            data: { stock: { decrement: line.quantity } },
          });
          if (updated.count === 0) {
            throw ApiError.badRequest(`"${line.title}" just went out of stock`, 'OUT_OF_STOCK');
          }
          // Take the same units out of the warehouses holding them, so the
          // location rows keep matching the variant total we just decremented.
          await allocateForDispatch(tx, {
            variantId: line.variantId,
            quantity: line.quantity,
            reference: orderNumber,
          });
        }
        // Coupon before credits, the order cancel and payment failure release
        // them in: two of one buyer's orders never wait on each other in a circle.
        // Reserve one redemption of the coupon (released again if payment fails).
        // Updating against the count we just read keeps a limited coupon from
        // being over-redeemed by two concurrent checkouts.
        if (couponCode && couponDiscountPaise > 0) {
          const coupon = await tx.coupon.findUnique({ where: { code: couponCode } });
          const exhausted =
            !coupon ||
            !coupon.isActive ||
            (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit);
          if (exhausted) {
            throw ApiError.badRequest('That coupon is no longer available', 'COUPON_INVALID');
          }
          // One use claimed atomically: under a limit only while uses are left
          // (Postgres re-checks the condition on the locked row), with no limit
          // always. Comparing against the count read above refused about half
          // of simultaneous checkouts of an unlimited code.
          const claimed = await tx.coupon.updateMany({
            where: { id: coupon.id, ...(coupon.usageLimit !== null ? { usedCount: { lt: coupon.usageLimit } } : {}) },
            data: { usedCount: { increment: 1 } },
          });
          if (claimed.count === 0) {
            throw ApiError.badRequest('That coupon is no longer available', 'COUPON_INVALID');
          }
        }
        // Reserve the credits (conditional — guards a concurrent double-spend).
        if (creditsUsed > 0) {
          const spent = await tx.user.updateMany({
            where: { id: userId, creditsBalance: { gte: creditsUsed } },
            data: { creditsBalance: { decrement: creditsUsed } },
          });
          if (spent.count === 0) {
            throw ApiError.badRequest('Your credits balance changed — please retry', 'CREDITS_CHANGED');
          }
        }
        const created = await tx.order.create({
          data: {
            orderNumber,
            userId,
            addressId: address.id,
            shipName: address.name,
            shipPhone: address.phone,
            shipLine1: address.line1,
            shipLine2: address.line2,
            shipCity: address.city,
            shipState: address.state,
            shipPincode: address.pincode,
            status: 'PLACED',
            subtotalPaise,
            shippingPaise,
            discountPaise,
            creditsUsed,
            couponCode,
            couponDiscountPaise,
            totalPaise,
            deliveryMethod,
            etaFrom: eta.from,
            etaTo: eta.to,
            isGift: isGift ?? false,
            giftMessage: isGift ? (giftMessage ?? null) : null,
            buyerGstin: buyerGstin || null,
            paymentMethod,
            checkoutKey: open.keyFree ? (checkoutKey ?? null) : null,
            checkoutFingerprint: fingerprint,
            billName: billing.name,
            billLine1: billing.line1,
            billLine2: billing.line2,
            billCity: billing.city,
            billState: billing.state,
            billPincode: billing.pincode,
            items: {
              // pricePaise is what the shopper actually pays per unit — a seller
              // promotion is already taken off it, so payouts, invoices and
              // refunds all read the same number.
              create: orderLines.map((line, i) => ({
                productId: line.productId,
                variantId: line.variantId,
                sellerId: sellerByVariant.get(line.variantId)!,
                title: line.title,
                size: line.size,
                color: line.color,
                variantLabel: variantById.get(line.variantId)?.label ?? line.label,
                optionValues: optionValuesFromJson(variantById.get(line.variantId)?.optionValues),
                pricePaise: line.pricePaise - Math.floor(line.promoDiscountPaise / line.quantity),
                quantity: line.quantity,
                status: 'PLACED',
                promotionId: line.promotion?.id ?? null,
                promoDiscountPaise: line.promoDiscountPaise,
                returnWindowDays: windowByProduct.get(line.productId) ?? null,
                returnable: returnableByProduct.get(line.productId) ?? true,
                nonCancellable: line.nonCancellable,
                gstRatePercent: gstRates[i],
                feeModel: 2,
                feeRates: feesByLine[i] as object,
              })),
            },
          },
        });
        if (creditsUsed > 0) {
          await tx.creditLedger.create({
            data: { userId, delta: -creditsUsed, reason: 'REDEEM_CHECKOUT', orderId: created.id },
          });
        }
        // Promotion usage trail — powers the seller's redemption and ROI panels.
        await recordRedemptions(tx as unknown as typeof prisma, {
          orderId: created.id,
          userId,
          lines: orderLines.map((line) => ({
            promotionId: line.promotion?.id ?? null,
            promoDiscountPaise: line.promoDiscountPaise,
            grossPaise: line.pricePaise * line.quantity,
          })),
        });
        return { kind: 'created' as const, order: created };
      }).catch((err: unknown) => {
        // Someone else took the stock between cancelling the earlier order and
        // placing this one: say so, rather than leave the buyer wondering where
        // their first order went.
        if (replacedEarlier && err instanceof ApiError && err.code === 'OUT_OF_STOCK') {
          throw new ApiError(
            400,
            'OUT_OF_STOCK',
            `${err.message}. Your earlier unpaid order for these items was released — please check the quantity and try again.`,
          );
        }
        throw err;
      });
      if (placed.kind === 'created') {
        order = placed.order;
      } else if (placed.kind === 'locked') {
        // Another checkout of this buyer holds the lock: wait outside any
        // transaction, so no database connection is held while waiting.
        if (Date.now() > lockDeadline) throw checkoutBusy();
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
        continue;
      } else if (placed.kind === 'reuse') {
        const again = await resumeOrder(placed.orderId);
        if (again) {
          res.json({ success: true, data: again });
          return;
        }
      } else if (placed.kind === 'replace') {
        await replaceOpenOrders(placed.orderIds);
        replacedEarlier = true;
      } else {
        throw checkoutBusy(placed.orderId);
      }
      round++;
    }
    await recordOrderPromises(order.id, promises).catch((err) =>
      console.error(`[clowe-api] ${orderNumber}: delivery promises not recorded:`, err instanceof Error ? err.message : err),
    );

    if (paymentMethod === 'COD') {
      // Nothing to collect now — the order is confirmed and the courier
      // collects on delivery, so the payment row stays CREATED.
      await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: 'cod',
          providerOrderId: `cod_${order.orderNumber}`,
          amountPaise: totalPaise,
          status: 'CREATED',
        },
      });
      await confirmCodOrder(order.id);

      const codBody: CheckoutResult = {
        orderId: order.id,
        orderNumber,
        amountPaise: totalPaise,
        method: paymentMethod,
        requiresPayment: false,
        payment: { provider: 'cod', providerOrderId: `cod_${order.orderNumber}` },
      };
      res.json({ success: true, data: codBody });
      return;
    }

    // Gateway order, outside the DB transaction. The payment row comes first,
    // so that if the gateway cannot be reached the order is cancelled and its
    // stock returned at once, rather than held by an order nobody can pay.
    const payment = await prisma.payment.create({
      data: { orderId: order.id, provider: paymentProvider.name, amountPaise: totalPaise, status: 'CREATED' },
    });
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true, name: true, email: true } });
    const plan = await planSplits(order.id);
    let gateway: Awaited<ReturnType<typeof createGatewayOrder>>;
    let splitUsed = false;
    try {
      const request = {
        kind: 'ORDER' as const,
        id: order.id,
        receipt: orderNumber,
        amountPaise: totalPaise,
        customer: { id: userId, phone: buyer.phone, name: buyer.name, email: buyer.email },
        note: `Clowe order ${orderNumber}`,
      };
      try {
        gateway = await createGatewayOrder({ ...request, splits: plan?.splits.map((x) => ({ vendorId: x.vendorId, amountPaise: x.amountPaise })) });
        splitUsed = !!plan;
      } catch (err) {
        // Easy Split refused (not enabled yet, a vendor not ready): the order is
        // still taken, collected into Clowe's account and paid out by payout.
        if (!plan || !(err instanceof GatewayError) || err.uncertain) throw err;
        console.warn(`[clowe-api] ${orderNumber}: Easy Split refused (${err.code || err.status}); collecting without splits`);
        gateway = await createGatewayOrder(request);
      }
    } catch (err) {
      await settlePaymentFailure(order.id, 'The payment gateway could not be reached');
      console.error(`[clowe-api] ${orderNumber}: gateway order failed:`, err instanceof Error ? err.message : err);
      throw new ApiError(502, 'GATEWAY_UNAVAILABLE', 'We could not start the payment just now. Nothing was charged — please try again.');
    }
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          providerOrderId: gateway.providerOrderId,
          paymentSessionId: gateway.paymentSessionId,
          expiresAt: gateway.expiresAt,
          settlementMode: splitUsed ? 'easy_split' : 'payouts',
        },
      });
      if (splitUsed && plan) {
        await tx.paymentSplit.createMany({
          data: plan.splits.map((s) => ({ paymentId: payment.id, sellerId: s.sellerId, vendorId: s.vendorId, amountPaise: s.amountPaise })),
        });
        for (const [itemId, share] of plan.lines) {
          await tx.orderItem.update({ where: { id: itemId }, data: { easySplitPaise: share } });
        }
      }
    });

    const body: CheckoutResult = {
      orderId: order.id,
      orderNumber,
      amountPaise: totalPaise,
      method: paymentMethod,
      requiresPayment: true,
      payment: checkoutPayload({ provider: paymentProvider.name, providerOrderId: gateway.providerOrderId, paymentSessionId: gateway.paymentSessionId }),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// My orders
// ---------------------------------------------------------------------------

const orderListQuery = z.object({
  status: z.enum(ORDER_FILTERS).default('ALL'),
  q: z.string().trim().max(60).optional(),
  /** Optional createdAt window for the "placed in" filter (ISO dates). */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** Which order statuses each chip covers. */
const FILTER_STATUSES: Record<OrderFilter, OrderStatus[] | null> = {
  ALL: null,
  PROCESSING: ['PLACED', 'CONFIRMED', 'PACKED'],
  SHIPPED: ['SHIPPED'],
  DELIVERED: ['DELIVERED'],
  CANCELLED: ['CANCELLED'],
  RETURNED: ['RETURN_REQUESTED', 'RETURNED', 'RTO_IN_TRANSIT', 'RTO_DELIVERED'],
};

ordersRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const query = orderListQuery.parse(req.query);

    const statuses = FILTER_STATUSES[query.status];
    const search = query.q
      ? {
          OR: [
            { orderNumber: { contains: query.q, mode: 'insensitive' as const } },
            { items: { some: { title: { contains: query.q, mode: 'insensitive' as const } } } },
          ],
        }
      : {};
    // "Placed in" window: [from, to).
    const placed =
      query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lt: query.to } : {}),
            },
          }
        : {};
    const where = {
      userId,
      ...(statuses ? { status: { in: statuses } } : {}),
      ...search,
      ...placed,
    };

    const [orders, total, allOrders] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          payment: { select: { provider: true } },
          _count: { select: { items: true } },
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  status: true,
                  categoryId: true,
                  sellerId: true,
                  images: { orderBy: { sortOrder: 'asc' }, take: 1 },
                },
              },
              variant: { select: { stock: true } },
            },
          },
        },
      }),
      prisma.order.count({ where }),
      // Counts + lifetime savings are computed over everything, not the page.
      prisma.order.findMany({
        where: { userId },
        select: { status: true, discountPaise: true, subtotalPaise: true, createdAt: true },
      }),
    ]);

    const counts = Object.fromEntries(
      ORDER_FILTERS.map((f) => {
        const list = FILTER_STATUSES[f];
        return [
          f,
          list === null
            ? allOrders.length
            : allOrders.filter((o) => list.includes(o.status)).length,
        ];
      }),
    ) as Record<OrderFilter, number>;

    const isHidden = await hiddenProductTest();
    const trackingByOrder = await ordersTrackingSummary(orders.map((o) => o.id));
    const rows: OrderListRow[] = orders.map((o) => {
      const images = o.items
        .map((i) => i.product.images[0]?.url)
        .filter((url): url is string => !!url);
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        totalPaise: o.totalPaise,
        itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
        previewImageUrl: images[0] ?? null,
        previewImages: images.slice(0, 4),
        productCount: o._count.items,
        paymentProvider: o.payment?.provider ?? null,
        deliveredAt:
          o.status === 'DELIVERED'
            ? (o.items
                .map((i) => i.deliveredAt)
                .filter((d): d is Date => d !== null)
                .sort((a, b) => b.getTime() - a.getTime())[0]
                ?.toISOString() ?? null)
            : null,
        etaFrom: o.etaFrom?.toISOString() ?? null,
        etaTo: o.etaTo?.toISOString() ?? null,
        canBuyAgain: o.items.every(
          (i) => i.product.status === 'APPROVED' && !isHidden(i.product) && i.variant.stock > 0,
        ),
        createdAt: o.createdAt.toISOString(),
        tracking: trackingByOrder.get(o.id) ?? null,
      };
    });

    const body: OrderListResponse = {
      items: rows,
      total,
      summary: {
        counts,
        totalSavedPaise: allOrders.reduce((sum, o) => sum + o.discountPaise, 0),
        firstOrderAt:
          allOrders.length > 0
            ? new Date(Math.min(...allOrders.map((o) => o.createdAt.getTime()))).toISOString()
            : null,
      },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

/** Re-add every item of a past order to the cart. */
ordersRouter.post('/:id/buy-again', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          include: {
            variant: { include: { product: { select: { id: true, status: true, categoryId: true, sellerId: true } } } },
          },
        },
      },
    });
    if (!order || order.userId !== userId) throw ApiError.notFound('Order not found');

    const cart = await prisma.cart.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });

    const isHidden = await hiddenProductTest();
    let moved = 0;
    const skipped: string[] = [];
    for (const item of order.items) {
      const sellable =
        item.variant.product.status === 'APPROVED' &&
        !isHidden(item.variant.product) &&
        item.variant.stock >= item.quantity;
      if (!sellable) {
        skipped.push(item.title);
        continue;
      }
      const existing = await prisma.cartItem.findUnique({
        where: { cartId_variantId: { cartId: cart.id, variantId: item.variantId } },
      });
      await prisma.cartItem.upsert({
        where: { cartId_variantId: { cartId: cart.id, variantId: item.variantId } },
        update: {
          quantity: Math.min((existing?.quantity ?? 0) + item.quantity, 10),
          selected: true,
        },
        create: { cartId: cart.id, variantId: item.variantId, quantity: item.quantity },
      });
      moved += 1;
    }
    if (moved === 0) {
      throw ApiError.badRequest('Nothing from this order is available right now', 'NOTHING_TO_ADD');
    }
    res.json({ success: true, data: { moved, skipped } });
  } catch (err) {
    next(err);
  }
});

ordersRouter.get('/:id', async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        payment: true,
        items: {
          include: {
            product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
            variant: { include: { product: { select: { id: true, status: true, categoryId: true, sellerId: true } } } },
            seller: { select: { shopName: true, returnWindowDays: true } },
            return: { include: { refund: true } },
            shipment: {
              select: {
                id: true,
                etaFrom: true,
                etaTo: true,
                courierPromisedAt: true,
                deliveryAttempts: true,
                lostFlaggedAt: true,
                lostChoice: true,
                events: { orderBy: { at: 'desc' as const }, take: 30, select: { at: true, status: true, location: true } },
              },
            },
            replacements: { select: { orderId: true, order: { select: { orderNumber: true } } } },
          },
        },
        sellerPromises: { include: { seller: { select: { shopName: true } } }, orderBy: { deliveryBy: 'asc' } },
      },
    });
    if (!order || order.userId !== req.auth!.userId) throw ApiError.notFound('Order not found');
    const promiseBySeller = new Map(order.sellerPromises.map((p) => [p.sellerId, p]));
    const promiseOf = (sellerId: string) => {
      const p = promiseBySeller.get(sellerId);
      return p
        ? { label: promiseLabel(p), deliveryBy: p.deliveryBy.toISOString(), deliveryByLatest: p.deliveryByLatest?.toISOString() ?? null }
        : null;
    };

    // Products this shopper has already reviewed — so "Write a review" only
    // shows where it can actually be used.
    const reviews = await prisma.review.findMany({
      where: {
        userId: req.auth!.userId,
        productId: { in: order.items.map((i) => i.productId) },
      },
      select: { productId: true },
    });
    const reviewedProductIds = new Set(reviews.map((r) => r.productId));

    // Net of any reversal: a cancelled or returned line takes its reward back.
    const earnedRows = await prisma.creditLedger.findMany({
      where: { orderId: order.id, reason: { in: ['EARN_PURCHASE', 'REVERSE_PURCHASE'] } },
      select: { delta: true },
    });
    const earnedCredits = Math.max(0, earnedRows.reduce((sum, r) => sum + r.delta, 0));

    // Order-level milestones = the last item to reach each stage.
    const shippedStamps = order.items.map((i) => i.shippedAt).filter((d): d is Date => d !== null);
    const deliveredStamps = order.items
      .map((i) => i.deliveredAt)
      .filter((d): d is Date => d !== null);
    const shippedAt =
      shippedStamps.length === order.items.length && shippedStamps.length > 0
        ? new Date(Math.max(...shippedStamps.map((d) => d.getTime())))
        : null;
    const deliveredAt =
      deliveredStamps.length === order.items.length && deliveredStamps.length > 0
        ? new Date(Math.max(...deliveredStamps.map((d) => d.getTime())))
        : null;

    // Packed items haven't left the warehouse yet, so they stay cancellable.
    const cancellable: OrderStatus[] = ['PLACED', 'CONFIRMED', 'PACKED'];
    const liveItems = order.items.filter((i) => !isNotASale(i.status));
    const intercept = await prisma.complaint.findFirst({
      where: { orderId: order.id, subject: INTERCEPT_SUBJECT, status: { notIn: ['RESOLVED', 'CLOSED'] } },
      select: { complaintId: true, status: true },
    });
    // Return window per item: the one it was sold with.
    const windowDaysByItem = new Map<string, number>();
    const returnableByItem = new Map<string, boolean>();
    for (const i of order.items) {
      windowDaysByItem.set(i.id, await orderLineReturnWindowDays(i));
      returnableByItem.set(i.id, await orderLineReturnable(i));
    }
    // Claims under the Return Policy, for lines delivered since its rules began.
    const claimByItem = new Map<string, OrderDetailItem['claim']>();
    for (const i of order.items) {
      if (!i.deliveredAt || (await rulesForDelivery(i.deliveredAt)) !== 'CLAIM') continue;
      const w = claimWindow(i.deliveredAt);
      const reasons = returnableByItem.get(i.id) === false ? [...CLAIM_REASONS_NON_RETURNABLE] : [...CLAIM_REASONS];
      claimByItem.set(i.id, {
        windowEndsAt: w.endsAt.toISOString(),
        latentUntil: w.latentUntil.toISOString(),
        reasons,
        exchangeAllowed: await exchangeAllowed(i.id, 'DEFECTIVE'),
      });
    }
    const platformWindowDays = (await getSettings()).returnWindowDays;
    const windowMsFor = (itemId: string) =>
      (windowDaysByItem.get(itemId) ?? platformWindowDays) * 24 * 60 * 60 * 1000;
    const isHidden = await hiddenProductTest();
    const body: OrderDetailView = {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      shipTo: {
        name: order.shipName,
        phone: order.shipPhone,
        line1: order.shipLine1,
        line2: order.shipLine2,
        city: order.shipCity,
        state: order.shipState,
        pincode: order.shipPincode,
      },
      discountPaise: order.discountPaise,
      creditsUsed: order.creditsUsed,
      couponCode: order.couponCode,
      couponDiscountPaise: order.couponDiscountPaise,
      deliveryMethod: order.deliveryMethod,
      paymentMethod: order.paymentMethod as CheckoutResult['method'],
      etaFrom: order.etaFrom?.toISOString() ?? null,
      etaTo: order.etaTo?.toISOString() ?? null,
      sellerPromises: order.sellerPromises.map((p) => ({ sellerId: p.sellerId, shopName: p.seller.shopName, ...promiseOf(p.sellerId)! })),
      isGift: order.isGift,
      giftMessage: order.giftMessage,
      earnedCredits,
      timeline: {
        placedAt: order.createdAt.toISOString(),
        confirmedAt:
          order.payment?.status === 'PAID' ? order.payment.updatedAt.toISOString() : null,
        // The order is "shipped"/"delivered" once every item has moved on.
        shippedAt: shippedAt?.toISOString() ?? null,
        deliveredAt: deliveredAt?.toISOString() ?? null,
      },
      items: order.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        productSlug: i.product.slug,
        title: i.title,
        size: i.size,
        color: i.color,
        variantLabel: i.variantLabel,
        quantity: i.quantity,
        pricePaise: i.pricePaise,
        status: i.status,
        imageUrl: i.product.images[0]?.url ?? null,
        shopName: i.seller.shopName,
        returnStatus: i.return?.status ?? null,
        returnInfo: i.return
          ? {
              id: i.return.id,
              status: i.return.status,
              reason: i.return.reasonCategory,
              details: i.return.reason || null,
              photos: i.return.photos,
              rejectionReason: i.return.rejectionReason,
              requestedAt: i.return.createdAt.toISOString(),
              approvedAt: i.return.approvedAt?.toISOString() ?? null,
              rejectedAt: i.return.rejectedAt?.toISOString() ?? null,
              receivedAt: i.return.receivedAt?.toISOString() ?? null,
              refund: i.return.refund
                ? {
                    status: i.return.refund.status,
                    amountPaise: i.return.refund.amountPaise,
                    processedAt: i.return.refund.processedAt?.toISOString() ?? null,
                    arn: i.return.refund.arn,
                  }
                : null,
            }
          : null,
        returnable: returnableByItem.get(i.id) ?? true,
        nonCancellable: i.nonCancellable,
        claim: claimByItem.get(i.id) ?? null,
        cancelReason: i.cancelReason,
        canReturn: claimByItem.get(i.id)
          ? // A claim: within 48 hours, or later for a hidden defect (the form asks).
            i.status === 'DELIVERED' && !i.return && Date.now() <= new Date(claimByItem.get(i.id)!.latentUntil).getTime()
          : (returnableByItem.get(i.id) ?? true) &&
            i.status === 'DELIVERED' &&
            !i.return &&
            !!i.deliveredAt &&
            Date.now() - i.deliveredAt.getTime() <= windowMsFor(i.id),
        scans: scanViews(i.shipment?.events),
        parcel: i.shipment
          ? {
              shipmentId: i.shipment.id,
              // Delhivery's own date, once it has given one, replaces the zone estimate.
              etaFrom: (i.shipment.courierPromisedAt ?? i.shipment.etaFrom)?.toISOString() ?? null,
              etaTo: (i.shipment.courierPromisedAt ?? i.shipment.etaTo)?.toISOString() ?? null,
              courierPromisedAt: i.shipment.courierPromisedAt?.toISOString() ?? null,
              deliveryAttempts: i.shipment.deliveryAttempts,
              lost: !!i.shipment.lostFlaggedAt,
              lostChoice: (i.shipment.lostChoice as LostParcelChoice | null) ?? null,
            }
          : null,
        deliveryPromise: promiseOf(i.sellerId),
        replacedBy: i.replacements[0] ? { orderId: i.replacements[0].orderId, orderNumber: i.replacements[0].order.orderNumber } : null,
        courierName: i.courierName,
        awbNumber: i.awbNumber,
        trackingUrl: i.trackingUrl,
        shippedAt: i.shippedAt?.toISOString() ?? null,
        deliveredAt: i.deliveredAt?.toISOString() ?? null,
        canReview: i.status === 'DELIVERED' && !reviewedProductIds.has(i.productId),
        variantId: i.variant.stock >= 0 && i.variant.product.status === 'APPROVED' && !isHidden(i.variant.product)
          ? i.variantId
          : null,
      })),
      subtotalPaise: order.subtotalPaise,
      shippingPaise: order.shippingPaise,
      totalPaise: order.totalPaise,
      payment: order.payment
        ? {
            provider: order.payment.provider,
            status: order.payment.status,
            transactionId: order.payment.providerPaymentId ?? order.payment.providerOrderId,
            paidAt: order.payment.paidAt?.toISOString() ?? null,
          }
        : null,
      awaitingPayment: order.payment?.status === 'CREATED' && order.status === 'PLACED',
      canCancel:
        order.status !== 'CANCELLED' &&
        liveItems.every((i) => cancellable.includes(i.status)) &&
        liveItems.some((i) => !lockedByNonCancellable(i)),
      canRequestIntercept: !intercept && liveItems.some((i) => i.status === 'SHIPPED'),
      interceptRequest: intercept ? { complaintId: intercept.complaintId, status: intercept.status } : null,
      claimWindowHours: CLAIM_WINDOW_HOURS,
      tracking: await orderTracking(order.id),
    };
    // Return photos are private; this is the buyer's own order.
    const returnBlocks = body.items.flatMap((i) => (i.returnInfo ? [i.returnInfo] : []));
    const resolved = await withPhotoUrls(returnBlocks);
    returnBlocks.forEach((block, k) => {
      block.photos = resolved[k].photos;
    });
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// "Refresh" on the buyer's tracking: asks Delhivery about the order's moving
// parcels, each at most once per 10 minutes; the order's tracking comes back.
ordersRouter.post('/:id/tracking/refresh', trackRefreshLimiter, async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, select: { id: true, userId: true } });
    if (!order || order.userId !== req.auth!.userId) throw ApiError.notFound('Order not found');
    const refresh = await refreshOrderTracking(order.id);
    res.json({ success: true, data: { ...refresh, tracking: await orderTracking(order.id) } });
  } catch (err) {
    next(err);
  }
});

// Cancel an order while nothing has shipped. Restores stock.
// The buyer's tax invoices: one per seller on the order, each issued by that
// seller under their GSTIN, naming Clowe Partners LLP as the marketplace —
// the same documents the sellers see (services/taxInvoice).
ordersRouter.get('/:id/invoices', async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      select: { userId: true, items: { select: { sellerId: true } } },
    });
    if (!order || order.userId !== req.auth!.userId) throw ApiError.notFound('Order not found');
    const sellerIds = [...new Set(order.items.map((i) => i.sellerId))];
    const invoices = (await Promise.all(sellerIds.map((id) => buildTaxInvoice(req.params.id, id)))).filter(
      (inv): inv is TaxInvoice => inv !== null,
    );
    res.json({ success: true, data: invoices });
  } catch (err) {
    next(err);
  }
});

// The credit notes reducing those invoices, for lines returned and refunded.
ordersRouter.get('/:id/credit-notes', async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!order || order.userId !== req.auth!.userId) throw ApiError.notFound('Order not found');
    const body: CreditNote[] = await creditNotesFor(req.params.id);
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// A parcel lost in transit: the buyer chooses a replacement or a refund (Shipping Policy 9.2).
ordersRouter.post('/:id/lost-parcels/:shipmentId/choice', async (req, res, next) => {
  try {
    const { choice } = z.object({ choice: z.enum(LOST_PARCEL_CHOICES) }).parse(req.body);
    const result = await chooseLostOutcome({
      orderId: req.params.id!,
      shipmentId: req.params.shipmentId!,
      userId: req.auth!.userId,
      choice,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

const BUYER_CANCELLABLE: OrderStatus[] = ['PLACED', 'CONFIRMED', 'PACKED'];
/** Sold non-cancellable and confirmed: the buyer can no longer cancel it (Cancellation Policy 2.1). */
const lockedByNonCancellable = (i: { nonCancellable: boolean; status: OrderStatus }) => i.nonCancellable && i.status !== 'PLACED';

// After dispatch the buyer can no longer cancel, but can ask support to stop
// the parcel (Cancellation Policy 1.2): a ticket forwarded to the seller and
// the courier, accommodated where it can still be intercepted.
ordersRouter.post('/:id/intercept', async (req, res, next) => {
  try {
    const { note } = interceptRequestSchema.parse(req.body ?? {});
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: { where: { status: 'SHIPPED' }, include: { seller: { select: { userId: true } } } } },
    });
    if (!order || order.userId !== req.auth!.userId) throw ApiError.notFound('Order not found');
    if (order.items.length === 0) {
      throw ApiError.badRequest('Nothing on this order is on its way — cancel it instead, or return it once delivered', 'NOT_IN_TRANSIT');
    }
    const open = await prisma.complaint.findFirst({
      where: { orderId: order.id, subject: INTERCEPT_SUBJECT, status: { notIn: ['RESOLVED', 'CLOSED'] } },
    });
    if (open) throw ApiError.badRequest(`You have already asked us to stop this parcel (${open.complaintId})`, 'ALREADY_REQUESTED');
    const items = order.items.map((i) => `"${i.title}"${i.awbNumber ? ` (AWB ${i.awbNumber})` : ''}`).join(', ');
    const complaint = await raiseComplaint({
      userId: order.userId,
      orderId: order.id,
      category: 'DELIVERY',
      subject: INTERCEPT_SUBJECT,
      description: `Please stop ${items} on order ${order.orderNumber} — I no longer want it.${note ? `\n\n${note}` : ''}`,
      priority: 'HIGH',
      channel: 'APP',
    });
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    const sellerUsers = [...new Set(order.items.map((i) => i.seller.userId))];
    await prisma.notification.createMany({
      data: [
        ...sellerUsers.map((userId) => ({
          userId,
          type: 'INTERCEPT_REQUEST',
          title: `Buyer asks to stop a parcel — ${order.orderNumber}`,
          body: `The buyer no longer wants ${items}. If the courier can still stop it, ask for it back; support will confirm (${complaint.complaintId}).`,
          linkHref: `/seller/orders/${order.id}`,
        })),
        ...admins.map((a) => ({
          userId: a.id,
          type: 'INTERCEPT_REQUEST',
          title: `Intercept request ${complaint.complaintId} — ${order.orderNumber}`,
          body: `Ask the courier to stop ${items}. If it can't be stopped, the buyer may refuse delivery (Cancellation Policy 1.3).`,
          linkHref: '/admin/support',
        })),
      ],
    });
    res.json({ success: true, data: { complaintId: complaint.complaintId } });
  } catch (err) {
    next(err);
  }
});

// Cancel before dispatch (Cancellation Policy 1.1): free, refunded in full —
// everything on the order except what was sold non-cancellable.
ordersRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!order || order.userId !== req.auth!.userId) throw ApiError.notFound('Order not found');
    if (order.status === 'CANCELLED') throw ApiError.badRequest('Order is already cancelled');
    const live = order.items.filter((i) => !isNotASale(i.status));
    if (!live.every((i) => BUYER_CANCELLABLE.includes(i.status))) {
      throw ApiError.badRequest(
        'Order cannot be cancelled after items have shipped — you can ask support to stop the parcel instead',
        'ALREADY_SHIPPED',
      );
    }
    const lines = live.filter((i) => !lockedByNonCancellable(i));
    if (lines.length === 0) {
      throw ApiError.badRequest('These items are non-cancellable once the order is confirmed', 'NON_CANCELLABLE');
    }
    const done = await cancelOrderLines({
      orderId: order.id,
      lineIds: lines.map((l) => l.id),
      statuses: BUYER_CANCELLABLE,
      by: 'CUSTOMER',
      actorUserId: order.userId,
      reason: 'Cancelled by customer',
    });
    res.json({ success: true, data: { cancelled: true, kept: live.length - lines.length, refund: done.refund } });
  } catch (err) {
    next(err);
  }
});

// Request a return for a delivered item (inside the return window).
ordersRouter.post('/items/:itemId/return', async (req, res, next) => {
  try {
    // Items delivered since the Return Policy's claim rules took effect are
    // claimed under them; anything delivered before keeps the old rules.
    const line = await prisma.orderItem.findUnique({ where: { id: req.params.itemId }, select: { deliveredAt: true } });
    if (line && (await rulesForDelivery(line.deliveredAt)) === 'CLAIM') {
      const result = await raiseClaim(req.auth!.userId, req.params.itemId, req.body);
      res.json({ success: true, data: result });
      return;
    }
    const input = returnRequestSchema.parse(req.body);
    if (input.photos?.length) {
      await assertOwnAssets(input.photos, { ownerId: req.auth!.userId, purpose: 'RETURN_PHOTO' });
    }
    const item = await prisma.orderItem.findUnique({
      where: { id: req.params.itemId },
      include: {
        order: { select: { userId: true, orderNumber: true, paymentMethod: true } },
        seller: { select: { userId: true, returnWindowDays: true } },
        product: { select: { categoryId: true, nonReturnable: true } },
        return: true,
      },
    });
    if (!item || item.order.userId !== req.auth!.userId) throw ApiError.notFound('Item not found');
    if (item.status !== 'DELIVERED') {
      throw ApiError.badRequest('Only delivered items can be returned');
    }
    if (item.return) throw ApiError.badRequest('Return already requested for this item');
    if (!(await orderLineReturnable(item))) {
      throw ApiError.badRequest('This item cannot be returned', 'NOT_RETURNABLE');
    }
    // Cash on Delivery: the refund is a bank transfer to the buyer's own
    // account, so it is asked for now (and stored encrypted, never shown to
    // the seller). A prepaid order is refunded to how it was paid.
    const cod = item.order.paymentMethod === 'COD';
    if (cod && !input.codRefundAccount) {
      throw ApiError.invalidField(
        'codRefundAccount.accountNumber',
        'Give the bank account (in your own name) for the refund — Cash on Delivery refunds are paid by bank transfer',
        'COD_REFUND_ACCOUNT_REQUIRED',
      );
    }
    const codRefundAccount = cod && input.codRefundAccount ? input.codRefundAccount : null;

    // Return window enforced server-side (UI hides the button, this is the law):
    // the window this line was sold with, whatever the setting says today.
    const windowDays = await orderLineReturnWindowDays(item);
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    if (!item.deliveredAt || Date.now() - item.deliveredAt.getTime() > windowMs) {
      throw ApiError.badRequest(
        `Returns are accepted within ${windowDays} days of delivery`,
        'RETURN_WINDOW_CLOSED',
      );
    }

    const rmaNumber = await nextRmaNumber();
    await prisma.$transaction([
      prisma.return.create({
        data: {
          rmaNumber,
          orderItemId: item.id,
          userId: req.auth!.userId,
          reasonCategory: input.reason,
          reason: input.details ?? '',
          photos: input.photos ?? [],
          ...(codRefundAccount
            ? {
                codRefundAccount: {
                  create: {
                    method: 'BANK',
                    last4: codRefundAccount.accountNumber.slice(-4),
                    cipher: encryptCodRefundAccount(codRefundAccount),
                  },
                },
              }
            : {}),
        },
      }),
      prisma.orderItem.update({
        where: { id: item.id },
        data: { status: 'RETURN_REQUESTED' },
      }),
      // Tell the seller a return needs their action.
      prisma.notification.create({
        data: {
          userId: item.seller.userId,
          type: 'RETURN_REQUESTED',
          title: 'Return requested ↩',
          body: `A customer requested a return for "${item.title}" (${item.order.orderNumber}). Review it in your seller panel → Returns.`,
        },
      }),
    ]);
    res.json({ success: true, data: { requested: true } });
  } catch (err) {
    next(err);
  }
});
