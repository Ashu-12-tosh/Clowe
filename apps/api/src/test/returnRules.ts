import type { PrismaClient } from '@prisma/client';

/**
 * Which return rules the items a test delivers fall under. The migration that
 * brought in the Return Policy's claims records when they began (at the
 * deploy); a fresh test database records "now", so every item a test
 * delivers is under the claims unless the test says otherwise.
 */
async function setClaimRulesFrom(prisma: PrismaClient, iso: string): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key: 'claimRulesFrom' },
    update: { value: iso },
    create: { key: 'claimRulesFrom', value: iso },
  });
}

/** Items delivered now are under the earlier return rules (delivered "before the deploy"). */
export const useEarlierReturnRules = (prisma: PrismaClient) => setClaimRulesFrom(prisma, '2999-01-01T00:00:00.000Z');

/** Items delivered now are under the Return Policy's claims. */
export const useClaimRules = (prisma: PrismaClient) => setClaimRulesFrom(prisma, '2000-01-01T00:00:00.000Z');
