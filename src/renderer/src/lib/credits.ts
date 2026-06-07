// Shared helpers for the credit-based usage UI (account menu balance,
// run-out popup, usage dashboard). Kept framework-free so any component
// can pull them in without a context.

// Friendly "refills" phrase from an ISO reset timestamp. Free plans refill
// daily, Pro weekly — both flow through the same relative phrasing:
//   <1h  → "in 12m"
//   <24h → "in 5h"
//   else → "tomorrow" / "in 3 days"
// Returns '' when no timestamp is known (older backend payloads).
export function formatResets(iso: string | undefined): string {
  if (!iso) return 'soon';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 'soon';
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'now';

  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `in ${Math.max(1, mins)}m`;
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(diffMs / 86400000);
  if (days <= 1) return 'tomorrow';
  return `in ${days} days`;
}

// The credit cost of each billable action, as product-facing copy for the
// plan/usage pages. These mirror the backend env weights (Haiku turn = 1,
// Sonnet turn = 4, Opus turn = 6; +image = +2; +diagram = +3). Display
// only — the backend is the source of truth for actual charges.
export interface CreditCostRow {
  label: string;
  cost: string;
}

export const CREDIT_COSTS: CreditCostRow[] = [
  { label: 'A request with Haiku or GPT-4o mini', cost: '1 credit' },
  { label: 'A request with Sonnet or GPT-4o', cost: '4 credits' },
  { label: 'A request with Opus', cost: '6 credits' },
  { label: 'A request with o3 (reasoning)', cost: '8 credits' },
  { label: 'Attaching an image', cost: '+2 credits' },
  { label: 'Showing a reply as a diagram', cost: '+3 credits' },
];

// What a credit grant means per tier, as a short human phrase for plan
// copy. Free refills every day; Pro every week.
export function grantPhrase(tier: string, limit: number): string {
  return tier === 'pro'
    ? `${limit.toLocaleString()} credits a week`
    : `${limit.toLocaleString()} credits a day`;
}
