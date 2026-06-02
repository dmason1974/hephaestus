# WW3 Build Plan — Project Context

## What This Project Is

A TypeScript planning engine for a strategy game. It simulates and optimises **how a country researches and mobilises military units** before a truce deadline. The core loop is: research a unit level → mobilise units across cities → pay ongoing upkeep until the deadline. The engine helps find the cheapest city/recruiting-office configuration to field a target force in time.

Unit and building data is AI-generated (Gemini) from in-game screenshots and stored as YAML. The Gemini gem has the schema files and exemplar YAMLs as a knowledge base.

---

## Architecture

```
src/
  schemas/                    Zod validators for all YAML data files
    unit-schema.ts            Unit catalogs (levels, research, mobilisation, upkeep)
    building-schema.ts        Buildings (recruiting office, arms industry, etc.)
    scenario-schema.ts        Scenario config (start day, truce length, unlock credit)

  engine/
    timing/
      activity-duration.ts    Shared timing helpers (durationToHours, morale slowdown)
    simulation/
      unit-research-sim.ts    Simulates research scheduling across slots/units
      unit-mobilization-plan.ts  Simulates mobilisation across cities
      build-order-sim.ts      Simulates full build order timeline
    optimization/
      types.ts                Shared types (ResourceCost, BatchAllocation, etc.)
      cost-calculator.ts      Mobilisation cost, upkeep cost, completion hour
      research-schedule-optimizer.ts   Greedy research schedule for a single unit
      batch-allocation-optimizer.ts    Distributes units across levels to minimise cost
      mobilization-config-generator.ts Enumerates city/RO configurations to evaluate
      force-projection-optimizer.ts    Top-level: finds best config for a unit+deadline

  cli/
    run-force-plan.ts         Entry point for force planning CLI
  harness/smoke/              Ad-hoc runner scripts (not tests)

data/
  buildings.yml               Shared building definitions
  scenarios/
    standard/
      ww3/                    Standard WW3 scenario (unlocked_through_day_at_start: 1)
    elite/
      ww3/                    Elite WW3 scenario (unlocked_through_day_at_start: 10)
      antarctica/             Elite Antarctica scenario
```

**Key data flow:**
`ForceProjectionOptimizer` → `optimizeResearchSchedule` (once, loop-invariant) → for each `MobilizationConfig`: `optimizeBatchAllocation` → `calculateTotalCost` → pick lowest-cost feasible solution.

---

## Key Domain Rules

- **Research slots**: the game allows 2 parallel research slots, but they apply across different units — levels of a single unit are always sequential (level N requires level N-1)
- **`unlocked_through_day_at_start`**: shifts all unlock gates back by N days. Formula: `effectiveUnlockDay = Math.max(1, unlockDay - unlockedThroughDayAtStart)`. So with value 10: unlock_day 1–11 all become available on day 1, unlock_day 12 becomes day 2, etc.
- **Prerequisite research is still required**: unlock day shifting does not bypass the research chain
- **Resource costs are sparse**: YAML cost blocks only list non-zero resources. Zero means the resource is not involved. The schema makes all resource fields optional.
- **`ResourceCost` type** is `Partial<Record<Resource, number>>` — absent key means zero, not unknown

---

## Session Changes (merged to main — 989d977)

### Bug fixes

| # | Location | Fix |
|---|---|---|
| 1 | `batch-allocation-optimizer` | `evaluateAllocation` hardcoded `feasible: true` regardless of deadline — infeasible alternatives returned with negative costs |
| 2 | `batch-allocation-optimizer` | Upkeep duration measured from `research.endHour` instead of `mobilizationEnd`, overcounting upkeep for all units |
| 3 | `research-schedule-optimizer` + `unit-research-sim` + `fixed-research-plan` | Unlock day formula ignored `unlocked_through_day_at_start`; also had an off-by-one (`-N+1` → `-N`). Elite scenario units had up to 10 days of phantom research delay |
| 4 | `research-schedule-optimizer` | `researchSlots` / `slotAvailableAt` were dead code — sequential level dependencies always dominate single-unit scheduling; removed |
| 5 | `force-projection-optimizer` | `optimizeResearchSchedule` recomputed identically for every city/RO config in the loop; hoisted outside |

### Refactoring

- `durationToHours` extracted into `activity-duration.ts`; 5 private copies removed

### Schema / data

- Resource cost fields made optional in `unit-schema.ts` and `building-schema.ts`
- 2,092 explicit `resource: 0` entries stripped from 17 YAML files — cost blocks are now sparse
- New elite_ww3_2026 country files: austria, france, italy, spain, united_kingdom
- New ww3_2026 plans: france_mrl, germany_mrl updated
- `tmp/` and `.claude/` added to `.gitignore`

---

## Immediate Next Steps

1. **Slot-aware research scheduling** — the optimizer currently treats research as single-threaded per unit (correct, since levels are sequential). If you want the force projection optimizer to account for the country's second slot being occupied by another unit's research, it would need to accept an `occupiedUntilHour` parameter and pass it to the research scheduler as an additional lower bound on `startHour`.

2. **Fix pre-existing test failures** — `unit-mobilization-plan.test.ts` and several `unit-research-sim.test.ts` tests fail because they load `data/units/naval_units.yml` and `seasonal_units.yml` which don't exist at that path. Either move the files or update the test fixture path.

3. **Update the Gemini gem** — re-upload the updated `unit-schema.ts`, `building-schema.ts`, and a few exemplar YAML unit files so future AI-generated unit data is sparse by default (no zero resource entries).

4. **Untracked scenario data** — `elite/ww3/countries/indonesia.yml`, `iraq.yml`, `philippines.yml`, `turkey.yml` were already committed in earlier sessions and are on main.
