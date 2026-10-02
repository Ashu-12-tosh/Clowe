import express, { Router } from 'express';
import { cspReportLimiter } from '../middleware/rateLimits';
import { parseCspReports } from '../services/cspReportParse';
import { recordCspViolations } from '../services/cspReports';

/**
 * Where browsers send Content-Security-Policy violation reports (the
 * policy's report-uri and report-to). Public by necessity — the browser
 * posts without credentials — so it is rate-limited, body-capped, and
 * always answers 204: a report is never worth an error page or a retry.
 */
export const cspReportsRouter = Router();

cspReportsRouter.post(
  '/',
  cspReportLimiter,
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
  async (req, res) => {
    try {
      await recordCspViolations(parseCspReports(req.body));
    } catch (err) {
      console.error('[clowe-api] csp report not recorded:', err instanceof Error ? err.message : err);
    }
    res.status(204).end();
  },
);
