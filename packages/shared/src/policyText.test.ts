import { describe, expect, it } from 'vitest';
import { fillPolicyText, POLICY_TOKENS } from './policyText';

const LIVE = {
  returnWindowDays: 5,
  dispatchSlaHours: 18,
  lateDispatchPenaltyAfterHours: 24,
  lateDispatchPenaltyPaise: 8000,
  sellerCancelPenaltyPaise: 15000,
  codMaxOrderPaise: 500000,
  gstUniformPercent: 18,
  supportEmails: { customer: 'customer-support@cloweshop.com', vendor: 'vendor-support@cloweshop.com' },
  sellerFees: {
    commissionPercent: 10,
    gatewayPercent: 2,
    platformFeePaise: 900,
    closingFeePaise: 2000,
    gtChargePaise: 3000,
    tdsPercent: 0.1,
    tcsPercent: 0.5,
    payoutHoldDays: 7,
    payoutMinPaise: 100000,
  },
};

describe('policy text', () => {
  it('fills every rule from settings, never a number of its own', () => {
    const text =
      'COD {{codMax}} · GST {{gst}} · {{commission}} + {{gatewayFee}} · {{platformFee}}/{{closingFee}}/{{gtCharge}} · ' +
      'TDS {{tds}} TCS {{tcs}} · hold {{payoutHold}} min {{payoutMin}} · cancel {{sellerCancelPenalty}} · ' +
      'late {{penaltyAmount}} after {{penaltyAfter}}, ship in {{dispatchSla}} · {{customerSupportEmail}} {{vendorSupportEmail}}';
    expect(fillPolicyText(text, LIVE)).toBe(
      'COD ₹5,000 · GST 18% · 10% + 2% · ₹9/₹20/₹30 · TDS 0.1% TCS 0.5% · hold 7 days min ₹1,000 · cancel ₹150 · ' +
        'late ₹80 after 24 hours, ship in 18 hours · customer-support@cloweshop.com vendor-support@cloweshop.com',
    );
  });

  it('quotes the retention the code uses for try-on photos and packing videos', () => {
    expect(fillPolicyText('{{tryonPhotoRetention}} / {{packingVideoDays}}', null)).toBe('24 hours / 45 days');
  });

  it('reads true without settings, with no number and no token left', () => {
    const all = POLICY_TOKENS.join(' ');
    const filled = fillPolicyText(all, null);
    expect(filled).not.toMatch(/\{\{/);
    expect(fillPolicyText('{{commission}} · {{codMax}}', null)).toBe('the rate shown on your Payouts page · the limit shown at checkout');
  });
});

describe('non-returnable categories in the Return Policy', () => {
  it('lists them from the category setting', () => {
    expect(fillPolicyText('{{nonReturnableCategories}}', { nonReturnableCategories: ['Fashion › Innerwear', 'Beauty'] })).toBe(
      'Fashion › Innerwear, Beauty',
    );
  });

  it('says none, or points at the product pages when unknown', () => {
    expect(fillPolicyText('{{nonReturnableCategories}}', { nonReturnableCategories: [] })).toBe('none at the moment');
    expect(fillPolicyText('{{nonReturnableCategories}}', null)).toBe('the categories whose products say "Not returnable"');
  });
});

describe('Cash on Delivery in help texts ({{codOffer}})', () => {
  it('never offers COD while it is switched off', () => {
    const off = fillPolicyText('{{codOffer}}', { codEnabled: false, codMinOrderPaise: 100000, codMaxOrderPaise: 500000 });
    expect(off).toBe('Cash on Delivery is not offered yet: every order is paid online, by UPI, card or net banking.');
  });

  it('gives the range once it is on', () => {
    const on = fillPolicyText('{{codOffer}}', { codEnabled: true, codMinOrderPaise: 100000, codMaxOrderPaise: 500000 });
    expect(on).toContain('Cash on Delivery is available on orders from ₹1,000 to ₹5,000');
  });

  it('promises nothing when settings are unknown', () => {
    expect(fillPolicyText('{{codOffer}}', null)).toBe('The payment step shows whether Cash on Delivery is offered for your order.');
  });
});
