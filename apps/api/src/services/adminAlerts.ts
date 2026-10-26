import { prisma } from '../db';

/**
 * Money that did not move as it should — a refund the bank turned down, a
 * payout that failed or came back, a Payouts balance too low to send one —
 * goes to every admin's bell (and on to email with the other notifications),
 * not only to the audit log, where nobody is watching for it.
 */
export async function alertAdmins(input: { type: string; title: string; body: string; linkHref: string }): Promise<void> {
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  if (admins.length === 0) return;
  await prisma.notification.createMany({
    data: admins.map((a) => ({ userId: a.id, type: input.type, title: input.title, body: input.body.slice(0, 500), linkHref: input.linkHref })),
  });
}

/** For paths that must not fail because the alert could not be written. */
export function alertAdminsSafe(input: Parameters<typeof alertAdmins>[0]): void {
  void alertAdmins(input).catch((err) => console.error('[clowe-api] admin alert failed:', err instanceof Error ? err.message : err));
}
