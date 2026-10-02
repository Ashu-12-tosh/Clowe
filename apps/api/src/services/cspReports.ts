import { prisma } from '../db';
import { fingerprint, type CspViolation } from './cspReportParse';

/** Reports older than this (by when they were last seen) are dropped. */
export const CSP_REPORT_RETENTION_DAYS = 30;

let lastPrune = 0;

/** Count each violation against its group, creating the group the first time. */
export async function recordCspViolations(violations: CspViolation[]): Promise<void> {
  for (const v of violations) {
    // One statement, so two reports for a new group at once cannot collide.
    await prisma.$executeRaw`
      INSERT INTO "csp_reports" ("id", "fingerprint", "directive", "blocked", "page", "disposition", "sample")
      VALUES (${'csp_' + fingerprint(v).slice(0, 24)}, ${fingerprint(v)}, ${v.directive}, ${v.blocked}, ${v.page}, ${v.disposition}, ${v.sample})
      ON CONFLICT ("fingerprint") DO UPDATE SET
        "count" = "csp_reports"."count" + 1,
        "lastSeenAt" = CURRENT_TIMESTAMP,
        "sample" = COALESCE("csp_reports"."sample", EXCLUDED."sample")`;
  }
  // Retention, at most hourly, piggy-backing on the traffic that creates rows.
  if (Date.now() - lastPrune > 60 * 60 * 1000) {
    lastPrune = Date.now();
    await prisma.cspReport.deleteMany({
      where: { lastSeenAt: { lt: new Date(Date.now() - CSP_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000) } },
    });
  }
}
