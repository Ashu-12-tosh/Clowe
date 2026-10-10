'use client';

import { fillPolicyText } from '@clowe/shared';
import { usePolicySettings } from '@/lib/returnWindow';

/**
 * Copy that may carry a platform-rule token ({{freeShippingFrom}},
 * {{returnWindow}}, …), filled from public settings. Until they arrive each
 * token reads as a phrase that is true without a number. Text with no token
 * comes out unchanged.
 */
export default function PolicyText({ text }: { text: string }) {
  return <>{fillPolicyText(text, usePolicySettings())}</>;
}
