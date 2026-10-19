/**
 * Plans and account tiers (Jacky, 2026-10-15).
 *
 * One catalog for every place that shows or checks a plan: the public
 * pricing page, /settings/plan, /settings, the platform console, the
 * checkout route and the worker's agent cap. The database keeps its own copy
 * of the limits in app.plan_limits() (migration 20261015000200) because the
 * gates that matter run there; plans.spec.ts pins the two copies to the same
 * numbers, so changing one without the other fails the build.
 *
 * Personal tiers live on workspaces.plan (a personal workspace is the
 * account); an organization's plan lives on organizations.plan and covers
 * every workspace it owns.
 *
 *   free · lite · pro · supporter · super_supporter   bought (free is the default)
 *   test_l1 · test_l2 · internal                      assigned by a platform superuser only
 *
 * test_l1 gets Pro's limits, test_l2 Supporter's (Beta included), internal
 * everything with no limit. None of the three is a developer account: the
 * /dev tools stay behind app.developer_accounts, as before.
 *
 * "AI analysis" is counted in distinct runs per calendar month (UTC) whose
 * DAF the server accepted. Re-analysing a run already counted this month is
 * free, so "re-run the analysis as often as you like" still holds.
 */

export const PERSONAL_PLANS = [
  'free', 'lite', 'pro', 'supporter', 'super_supporter', 'test_l1', 'test_l2', 'internal',
] as const;
export const ORG_PLANS = ['free', 'team', 'enterprise'] as const;
/** Personal plans someone can buy through checkout. */
export const PURCHASABLE_PLANS = ['lite', 'pro', 'supporter', 'super_supporter'] as const;
/** Personal plans only a platform superuser can set. */
export const ASSIGNED_PLANS = ['test_l1', 'test_l2', 'internal'] as const;

export type PersonalPlan = (typeof PERSONAL_PLANS)[number];
export type OrgPlan = (typeof ORG_PLANS)[number];
export type PurchasablePlan = (typeof PURCHASABLE_PLANS)[number];
export type PlanId = PersonalPlan | OrgPlan;

export interface PlanLimits {
  /** Stored bundle bytes, in GB (1024^3). null = no limit. */
  storageGb: number | null;
  /** Distinct runs analysed per calendar month (UTC). null = no limit. */
  analysisRunsPerMonth: number | null;
  /** Agents that are not archived. null = no limit. */
  maxActiveAgents: number | null;
  /** Share links for conversations and notes, note / deck exports, full export. */
  shareExport: boolean;
  /** May turn off the de-identified corpus contribution. */
  corpusOptOut: boolean;
  /** Early access to Beta features. */
  betaFeatures: boolean;
  /** A direct line to the team for suggestions and feature requests. */
  featureRequests: boolean;
}

const FREE: PlanLimits = {
  storageGb: 1, analysisRunsPerMonth: 20, maxActiveAgents: 2,
  shareExport: false, corpusOptOut: false, betaFeatures: false, featureRequests: false,
};
const LITE: PlanLimits = {
  storageGb: 30, analysisRunsPerMonth: 60, maxActiveAgents: 5,
  shareExport: true, corpusOptOut: false, betaFeatures: false, featureRequests: false,
};
const PRO: PlanLimits = {
  storageGb: 100, analysisRunsPerMonth: null, maxActiveAgents: 50,
  shareExport: true, corpusOptOut: true, betaFeatures: false, featureRequests: false,
};
const SUPPORTER: PlanLimits = {
  storageGb: 500, analysisRunsPerMonth: null, maxActiveAgents: null,
  shareExport: true, corpusOptOut: true, betaFeatures: true, featureRequests: false,
};
const SUPER_SUPPORTER: PlanLimits = { ...SUPPORTER, featureRequests: true };
const UNLIMITED: PlanLimits = {
  storageGb: null, analysisRunsPerMonth: null, maxActiveAgents: null,
  shareExport: true, corpusOptOut: true, betaFeatures: true, featureRequests: true,
};
const TEAM: PlanLimits = {
  storageGb: null, analysisRunsPerMonth: null, maxActiveAgents: null,
  shareExport: true, corpusOptOut: true, betaFeatures: false, featureRequests: false,
};

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: FREE,
  lite: LITE,
  pro: PRO,
  supporter: SUPPORTER,
  super_supporter: SUPER_SUPPORTER,
  test_l1: PRO,
  test_l2: SUPPORTER,
  internal: UNLIMITED,
  team: TEAM,
  enterprise: { ...TEAM, featureRequests: true },
};

/** Unknown plan names get Free's limits: a typo must never unlock anything. */
export function planLimits(plan: string | null | undefined): PlanLimits {
  return (plan && (PLAN_LIMITS as Record<string, PlanLimits>)[plan]) || FREE;
}

export const PLAN_LABEL: Record<PlanId, { en: string; zh: string }> = {
  free: { en: 'Free', zh: 'Free' },
  lite: { en: 'Lite', zh: 'Lite' },
  pro: { en: 'Pro', zh: 'Pro' },
  supporter: { en: 'Supporter', zh: 'Supporter 贊助者' },
  super_supporter: { en: 'Super Supporter', zh: 'Super Supporter 超級贊助者' },
  test_l1: { en: 'test-L1', zh: 'test-L1' },
  test_l2: { en: 'test-L2', zh: 'test-L2' },
  internal: { en: 'Internal', zh: 'Internal' },
  team: { en: 'Team', zh: 'Team' },
  enterprise: { en: 'Enterprise', zh: 'Enterprise' },
};
export const planLabel = (plan: string, zh = false): string =>
  (PLAN_LABEL as Record<string, { en: string; zh: string }>)[plan]?.[zh ? 'zh' : 'en'] ?? plan;

/**
 * List prices in USD. Stripe's price objects are the truth once billing is
 * connected; keep these equal to them. Yearly is ten months' price (two
 * months free). Super Supporter is pay-what-you-want from its minimum,
 * monthly only.
 */
export const PRICES = {
  lite: { month: 5.99, year: 59.9 },
  pro: { month: 13.99, year: 139.9 },
  supporter: { month: 24.99, year: 249.9 },
  super_supporter: { monthMin: 49.99 },
  team: { seatMonth: 11.99, seatYear: 119.9, minSeats: 3 },
} as const;

export const SUPER_SUPPORTER_MIN_CENTS = Math.round(PRICES.super_supporter.monthMin * 100);
/** Upper bound on a Super Supporter amount: a typo of 4999.00 should not go through unasked. */
export const SUPER_SUPPORTER_MAX_CENTS = 100_000;

export const isPersonalPlan = (p: string): p is PersonalPlan => (PERSONAL_PLANS as readonly string[]).includes(p);
export const isPurchasablePlan = (p: string): p is PurchasablePlan => (PURCHASABLE_PLANS as readonly string[]).includes(p);
export const isAssignedPlan = (p: string): boolean => (ASSIGNED_PLANS as readonly string[]).includes(p);

/** Where `plan` sits among the buyable tiers, for "upgrade" vs "change" wording. -1 = not on the ladder. */
export function planRank(plan: string): number {
  return ['free', ...PURCHASABLE_PLANS].indexOf(plan);
}
