import type { MerchantCategory, ModelId, OutreachState } from "./contracts";

/**
 * Display formatting.
 *
 * Every formatter here pins its locale to "en-US" rather than letting `Intl`
 * pick up the runtime default. The server and the browser can disagree about
 * that default, and when they do, React reports a hydration mismatch on a
 * number that looked fine on both sides. The interface is in English; the
 * number formatting should be too, deterministically.
 */

const DECIMAL = new Intl.NumberFormat("en-US");

/**
 * Money. Costs in this pipeline are frequently fractions of a cent — a triage
 * call on Haiku lands around $0.0004 — so two decimal places would round the
 * interesting part of the number away.
 */
export function formatUsd(value: number, fractionDigits = 4): string {
  return `$${value.toFixed(fractionDigits)}`;
}

/** Larger totals, where cents are the right resolution. */
export function formatUsdCoarse(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  return DECIMAL.format(value);
}

export function formatPercent(ratio: number, fractionDigits = 1): string {
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

export function formatScore(value: number): string {
  return value.toFixed(0);
}

export function formatConfidence(value: number): string {
  return value.toFixed(2);
}

/**
 * Age of a record, as a queue would show it: coarse, sortable by eye, never
 * more than two units.
 *
 * `now` is passed in rather than read from the clock. Mock data is fixed in
 * time, and a component that called `Date.now()` during render would produce a
 * different string on the server than in the browser.
 */
export function formatAge(iso: string, now: string): string {
  const deltaMs = Date.parse(now) - Date.parse(iso);
  if (Number.isNaN(deltaMs)) return "—";
  return formatDuration(Math.max(deltaMs, 0));
}

/** Compact duration: "3h 41m", "2d 4h", "18m". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }

  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder === 0 ? `${days}d` : `${days}d ${remainder}h`;
}

/** Timestamp in a fixed, sortable shape. Never a localised long date. */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * Shortens a hash for display while keeping it recognisable. The full value is
 * always available too — the dedup key is shown in full on the draft detail,
 * because that screen is where it matters.
 */
export function truncateHash(hash: string, head = 12): string {
  return hash.length <= head ? hash : `${hash.slice(0, head)}…`;
}

/** Model names as an operator says them, not as the API spells them. */
export function formatModel(model: ModelId): string {
  switch (model) {
    case "claude-haiku-4-5-20251001":
      return "Haiku 4.5";
    case "claude-sonnet-5":
      return "Sonnet 5";
    case "claude-opus-5":
      return "Opus 5";
  }
}

export function formatCategory(category: MerchantCategory): string {
  switch (category) {
    case "restaurant":
      return "Restaurant";
    case "spa_wellness":
      return "Spa & wellness";
    case "fitness":
      return "Fitness";
    case "beauty":
      return "Beauty";
    case "activity":
      return "Activity";
    case "class_workshop":
      return "Class & workshop";
  }
}

export function formatState(state: OutreachState): string {
  // Lifecycle states are shown as the backend spells them, minus the
  // underscore. An operator comparing the screen against a log line should see
  // the same word in both places.
  return state.replace(/_/g, " ");
}

/** Field names from the merchant record, as column headings rather than keys. */
export function formatFieldName(field: string): string {
  const spaced = field.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
