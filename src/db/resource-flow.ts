import type { PoolClient } from "pg";

import type { Resource } from "../core/constants.js";

/**
 * Shared resource-column plumbing for every DB read/write path — the wide-column
 * "Resource -> number" shape recurs across resource_flow, eco_step_delta,
 * force_infra_step, force_research_segment, etc. Extracted out of
 * eco-run-repository.ts/eco-run-reader.ts (which duplicated this) so a second
 * writer (force-run-repository.ts) and reader (force-run-reader.ts) don't have to
 * duplicate it again.
 */

/** Column order for every resource-bearing table. Must match `Resource`. */
export const RESOURCE_COLUMNS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

export type ResourceAmounts = Partial<Record<Resource, number>>;

/** resource_flow.scope_type */
export type ResourceScope = "run" | "country" | "city" | "province_cohort";

export function resourceValues(amounts: ResourceAmounts): number[] {
  return RESOURCE_COLUMNS.map(r => amounts[r] ?? 0);
}

export function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

export function addInto(target: Record<Resource, number>, source: ResourceAmounts): void {
  for (const r of RESOURCE_COLUMNS) target[r] += source[r] ?? 0;
}

/** Sums an hourly production series into a single per-resource total. */
export function sumHourly(hourly: Array<Record<Resource, number>>): Record<Resource, number> {
  const total = zeroResources();
  for (const hour of hourly) {
    for (const r of RESOURCE_COLUMNS) total[r] += hour[r] ?? 0;
  }
  return total;
}

export async function insertResourceFlow(
  client: PoolClient,
  runId: number,
  scopeType: ResourceScope,
  scopeId: number | null,
  category: string,
  amounts: ResourceAmounts
): Promise<void> {
  await client.query(
    `INSERT INTO resource_flow
       (run_id, scope_type, scope_id, category, ${RESOURCE_COLUMNS.join(", ")})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [runId, scopeType, scopeId, category, ...resourceValues(amounts)]
  );
}

// ── Read-side coercion — Postgres NUMERIC always comes back as a string ────────

/** Coerces a resource_flow NUMERIC column to a number; missing/null -> 0. */
export function toNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : parseFloat(String(value));
}

/** Same as toNum, but preserves "genuinely absent" as null instead of 0. */
export function toNumOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

/** Reads a resource_flow row's 7 resource columns into a resource map. */
export function resourceRowToMap(row: Record<string, unknown>): Partial<Record<Resource, number>> {
  const out: Partial<Record<Resource, number>> = {};
  for (const r of RESOURCE_COLUMNS) out[r] = toNum(row[r]);
  return out;
}
