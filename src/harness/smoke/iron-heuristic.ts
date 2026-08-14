// Shared "iron" heuristic constants — hand-specified eco investment policy, used
// identically by iron-eco-plan.ts and iron-bp-plan.ts. Kept in one place so the two
// scripts can't drift now that they're run per-country in a loop.

// supplies/electronics cities → RO1, then arms_industry straight to L5. rares
// cities → RO1, then arms_industry to L3 only (per user direction — rares is
// capped lower than supplies/electronics, applied across the air builds and the
// MRL builds alike). components/fuel cities → RO1, then arms_industry to a lower
// target only. Nothing else in any case — no beam continuation for this heuristic.
export const AI_TARGET_BY_RESOURCE: Record<string, number> = {
  supplies: 5,
  electronics: 5,
  rares: 3,
  components: 2,
  fuel: 1,
};

// Province build sequence per cohort resource. supplies/electronics cohorts get a
// real build sequence (matches Italy's beam-computed sequence, transcribed once and
// found ROI-positive); rares/components/fuel/non-resource cohorts are intentionally
// build-less (base production only) — same treatment Italy's components/fuel
// provinces got, not extended to rares even where a country has one (e.g. South
// Africa) for this rollout.
export const PROVINCE_BUILD_ORDER: Record<
  string,
  Array<{ buildingId: "local_industry" | "combat_outpost"; targetLevel: number }>
> = {
  supplies: [
    { buildingId: "local_industry", targetLevel: 1 },
    { buildingId: "local_industry", targetLevel: 2 },
    { buildingId: "local_industry", targetLevel: 3 },
    { buildingId: "combat_outpost", targetLevel: 1 },
  ],
  electronics: [
    { buildingId: "local_industry", targetLevel: 1 },
    { buildingId: "local_industry", targetLevel: 2 },
    { buildingId: "combat_outpost", targetLevel: 1 },
    { buildingId: "local_industry", targetLevel: 3 },
  ],
};

// Occupied-country heuristic: annex + AI5 for electronics cities only. supplies
// cities are intentionally excluded (per user direction — no annex, no arms_industry,
// base occupied-rate production only, same treatment as rares/components/fuel).
// Currently only affects Norway, the only occupied country with a supplies-tile city
// (Bergen, Stavanger) — Madagascar/Solomon Islands/Iran don't have one.
export const OCCUPIED_AI_TARGET_BY_RESOURCE: Record<string, number> = {
  electronics: 5,
};

// Same build sequence for both supplies and electronics provinces (unlike the
// homeland PROVINCE_BUILD_ORDER above, where supplies and electronics differ) — per
// user's exact instruction. rares/components/fuel/non-resource: no build.
export const OCCUPIED_PROVINCE_BUILD_ORDER: Record<
  string,
  Array<{ buildingId: "local_industry" | "combat_outpost"; targetLevel: number }>
> = {
  supplies: [
    { buildingId: "local_industry", targetLevel: 1 },
    { buildingId: "local_industry", targetLevel: 2 },
    { buildingId: "combat_outpost", targetLevel: 1 },
    { buildingId: "local_industry", targetLevel: 3 },
  ],
  electronics: [
    { buildingId: "local_industry", targetLevel: 1 },
    { buildingId: "local_industry", targetLevel: 2 },
    { buildingId: "combat_outpost", targetLevel: 1 },
    { buildingId: "local_industry", targetLevel: 3 },
  ],
};
