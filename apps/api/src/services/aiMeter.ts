import type { Request } from 'express';
import {
  aiCallCostPaise,
  aiSettingsSchema,
  DEFAULT_AI_SETTINGS,
  istMonthBounds,
  istMonthOf,
  istStartOfDay,
  type AiSettings,
  type AiUsageView,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { rawAiProvider, type AiCompleteInput, type AiTask } from './ai';

// ---------------------------------------------------------------------------
// Every AI call goes through here (owner's overnight run): a monthly budget
// for all of them together (₹1,000 by default), a daily limit per shopper and
// per seller, and a log of tokens and cost for the admin's usage view. When
// the budget or a limit is reached, or the provider fails, callers fall back
// (plain search, no summary, a polite note) — never an error page.
// ---------------------------------------------------------------------------

const SETTING_KEY = 'ai';
const SELLER_TASKS: AiTask[] = ['product-description', 'marketing', 'seller-assistant'];

export class AiUnavailable extends Error {
  constructor(readonly reason: 'budget' | 'limit' | 'error', message: string) {
    super(message);
  }
}

export async function getAiSettings(): Promise<AiSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: SETTING_KEY } });
  const parsed = aiSettingsSchema.partial().safeParse(row?.value ?? {});
  return { ...DEFAULT_AI_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}

export async function updateAiSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  const next = aiSettingsSchema.parse({ ...(await getAiSettings()), ...patch });
  await prisma.platformSetting.upsert({ where: { key: SETTING_KEY }, update: { value: next }, create: { key: SETTING_KEY, value: next } });
  return next;
}

/** Who is asking: the signed-in user, else the visitor's address. */
export function aiUserKey(req: Request): string {
  return req.auth?.userId ? `u:${req.auth.userId}` : `ip:${req.ip ?? 'unknown'}`;
}

async function monthSpentPaise(now: Date): Promise<number> {
  const { from, to } = istMonthBounds(istMonthOf(now));
  const r = await prisma.aiUsage.aggregate({ where: { createdAt: { gte: from, lt: to } }, _sum: { costPaise: true } });
  return r._sum.costPaise ?? 0;
}

/**
 * One AI call, metered. `userKey` (aiUserKey) is counted against the daily
 * limit unless `exempt` (admins). Throws AiUnavailable; never anything else.
 */
export async function aiCall(input: AiCompleteInput & { userKey?: string | null; exempt?: boolean }): Promise<string> {
  const now = new Date();
  const s = await getAiSettings();
  if ((await monthSpentPaise(now)) >= s.monthlyBudgetPaise) {
    throw new AiUnavailable('budget', 'AI features are paused for the rest of this month.');
  }
  if (input.userKey && !input.exempt) {
    const limit = SELLER_TASKS.includes(input.task) ? s.sellerDailyCalls : s.shopperDailyCalls;
    const used = await prisma.aiUsage.count({ where: { userKey: input.userKey, createdAt: { gte: istStartOfDay(now) } } });
    if (used >= limit) throw new AiUnavailable('limit', "You've used today's AI requests. Please try again tomorrow.");
  }
  const base = { task: input.task, provider: rawAiProvider.name, model: rawAiProvider.model, userKey: input.userKey ?? null };
  try {
    const r = await rawAiProvider.complete(input);
    await prisma.aiUsage.create({
      data: { ...base, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costPaise: aiCallCostPaise(s, r.inputTokens, r.outputTokens) },
    });
    return r.text;
  } catch (err) {
    const usage = (err as { usage?: { inputTokens: number; outputTokens: number } }).usage;
    await prisma.aiUsage
      .create({
        data: {
          ...base,
          ok: false,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          costPaise: usage ? aiCallCostPaise(s, usage.inputTokens, usage.outputTokens) : 0,
        },
      })
      .catch(() => {});
    console.error(`[clowe-api] AI ${input.task} failed:`, err instanceof Error ? err.message : err);
    throw new AiUnavailable('error', 'AI could not answer just now. Please try again in a moment.');
  }
}

/** For a seller tool or the assistant: AiUnavailable becomes a polite 503 the page can show. */
export function aiHttpError(err: unknown): unknown {
  if (err instanceof AiUnavailable) return new ApiError(err.reason === 'limit' ? 429 : 503, err.reason === 'limit' ? 'AI_LIMIT' : 'AI_UNAVAILABLE', err.message);
  return err;
}

export async function aiUsageView(month: string): Promise<AiUsageView> {
  const s = await getAiSettings();
  const { from, to } = istMonthBounds(month);
  const rows = await prisma.aiUsage.findMany({ where: { createdAt: { gte: from, lt: to } }, orderBy: { createdAt: 'desc' } });
  const byTask = new Map<string, { calls: number; costPaise: number }>();
  const byDay = new Map<string, { calls: number; costPaise: number }>();
  for (const r of rows) {
    const t = byTask.get(r.task) ?? { calls: 0, costPaise: 0 };
    t.calls += 1;
    t.costPaise += r.costPaise;
    byTask.set(r.task, t);
    const day = new Date(r.createdAt.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const d = byDay.get(day) ?? { calls: 0, costPaise: 0 };
    d.calls += 1;
    d.costPaise += r.costPaise;
    byDay.set(day, d);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    month,
    provider: rawAiProvider.name,
    model: rawAiProvider.model,
    settings: s,
    spentPaise: round(rows.reduce((t, r) => t + r.costPaise, 0)),
    calls: rows.length,
    failed: rows.filter((r) => !r.ok).length,
    inputTokens: rows.reduce((t, r) => t + r.inputTokens, 0),
    outputTokens: rows.reduce((t, r) => t + r.outputTokens, 0),
    byTask: [...byTask.entries()].map(([task, v]) => ({ task, calls: v.calls, costPaise: round(v.costPaise) })).sort((a, b) => b.costPaise - a.costPaise),
    byDay: [...byDay.entries()].map(([day, v]) => ({ day, calls: v.calls, costPaise: round(v.costPaise) })).sort((a, b) => a.day.localeCompare(b.day)),
    recent: rows.slice(0, 30).map((r) => ({ at: r.createdAt.toISOString(), task: r.task, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costPaise: round(r.costPaise), ok: r.ok })),
  };
}
