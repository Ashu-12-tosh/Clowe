import { TRYON_CONSENT_VERSION } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';

/**
 * Refuse a try-on step (uploading a try-on photo, running a try-on) without
 * the shopper's consent in its current wording (Privacy Policy 3).
 */
export async function assertTryOnConsent(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { tryOnConsentVersion: true } });
  if (user?.tryOnConsentVersion !== TRYON_CONSENT_VERSION) {
    throw ApiError.forbidden(
      'Please confirm you are 18+ and the photo is of you or of an adult who has consented',
      'TRYON_CONSENT_REQUIRED',
    );
  }
}
