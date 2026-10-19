import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { recordAudit } from './auditService';

/**
 * Pre-launch audit (2026-10-20): references were numbered by counting today's
 * rows and retrying five times on a collision, so writes arriving together
 * (a payout reversal from the poller beside a webhook, a busy admin) could
 * all collide and the row was dropped with only a console line.
 */

const prisma = new PrismaClient();
const marker = `audit-concurrency-${Date.now()}`;

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { summary: { startsWith: marker } } });
  await prisma.$disconnect();
});

describe('audit log references', () => {
  it('keeps every row, with its own sequential reference, when many are written at once', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        recordAudit({ actorRole: 'SYSTEM', module: 'PAYMENTS', action: 'TEST', summary: `${marker} #${i}` }),
      ),
    );
    const rows = await prisma.auditLog.findMany({ where: { summary: { startsWith: marker } }, select: { reference: true } });
    expect(rows).toHaveLength(25);
    expect(new Set(rows.map((r) => r.reference)).size).toBe(25);
    for (const r of rows) expect(r.reference).toMatch(/^LOG-\d{8}-\d{6}$/);
  });
});
