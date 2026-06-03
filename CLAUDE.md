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
      units/                  Shared unit catalog for all standard scenarios (9 files)
      ww3/                    Standard WW3 scenario (unlocked_through_day_at_start: 1)
    elite/
      units/                  Shared unit catalog for all elite scenarios (8 files)
      ww3/                    Elite WW3 scenario (unlocked_through_day_at_start: 10)
      antarctica/             Elite Antarctica scenario
```

**Unit catalog resolution order** (per scenario): scenario-local `units/` → tier-shared `units/` (e.g. `elite/units/`) → error if neither exists.

**Key data flow:**
`ForceProjectionOptimizer` → `optimizeResearchSchedule` (once, loop-invariant) → for each `MobilizationConfig`: `optimizeBatchAllocation` → `calculateTotalCost` → pick lowest-cost feasible solution.

---

## Key Domain Rules

- **Research slots**: the game allows 2 parallel research slots, but they apply across different units — levels of a single unit are always sequential (level N requires level N-1)
- **`unlocked_through_day_at_start`**: shifts all unlock gates back by N days. Formula: `effectiveUnlockDay = Math.max(1, unlockDay - unlockedThroughDayAtStart)`. So with value 10: unlock_day 1–11 all become available on day 1, unlock_day 12 becomes day 2, etc.
- **Prerequisite research is still required**: unlock day shifting does not bypass the research chain
- **Resource costs are sparse**: YAML cost blocks only list non-zero resources. Zero means the resource is not involved. The schema makes all resource fields optional.
- **`ResourceCost` type** is `Partial<Record<Resource, number>>` — absent key means zero, not unknown
- **Country doctrine**: each country has a doctrine (e.g. `european`, `western`). Research times, research costs, mobilisation times, mobilisation costs, and daily upkeep all vary by doctrine. The `doctrine` field on a unit is an array (1–3 values) listing which doctrines can use it.

---

## Unit YAML Schema — Per-Doctrine Level Structure

Unit levels now store costs and timings keyed by doctrine. `unlock_day` and `requirements` are shared across all doctrines. Example:

```yaml
air_superiority_fighter:
  name: Air Superiority Fighter
  category: Air
  doctrine:
    - european
    - western
  levels:
    "1":
      requirements:
        - air_base level 1
        - arms_industry level 1
      unlock_day: 1
      research:
        european:
          time: { hours: 22, minutes: 30 }
          cost: { supplies: 1800, rares: 1900, cash: 4000 }
        western:
          time: { minutes: 30 }
          cost: { supplies: 1800, rares: 1900, cash: 4000 }
      mobilisation:
        european:
          time: { hours: 23 }
          cost: { components: 1000, manpower: 425, electronics: 950, cash: 3500 }
        western:
          time: { days: 1 }
          cost: { components: 900, electronics: 850, cash: 3150, manpower: 375 }
      daily_upkeep:
        european:
          cost: { manpower: 35, fuel: 35, electronics: 35, cash: 100 }
        western:
          cost: { fuel: 35, electronics: 35, cash: 100, manpower: 35 }
```

**Backwards compatibility**: old flat-format YAMLs (research/mobilisation/upkeep not keyed by doctrine) are auto-normalised on parse using the unit's `doctrine` array. Existing files do not need to be rewritten.

**Partial doctrine data is valid**: a unit may have data for only some of its doctrines at some levels (e.g. levels 2–7 may only have `western` data while `european` screenshots are pending).

---

## Immediate Next Steps

1. **Update engine layer for per-doctrine costs** — `cost-calculator.ts`, `research-schedule-optimizer.ts`, `batch-allocation-optimizer.ts`, and `force-projection-optimizer.ts` all read `unit.levels[n].research.time` / `.cost` / `.mobilisation` directly. These need a `doctrine` parameter threaded through so they look up `research[doctrine]`, `mobilisation[doctrine]`, etc. This is the primary blocker for the optimizer working correctly with the new schema. 13 engine tests currently fail because of this.

2. **Populate missing unit YAML data** — `standard/units/` and `elite/units/` are missing many units that exist in tests (e.g. `naval_veteran`, `fixed_wing_veteran`, `deployable_gear`, `elite_frigate` in standard). These will be added from screenshots. 13 pre-existing test failures are due to missing unit definitions.

3. **Update the Gemini gem** — re-upload `unit-schema.ts` and `elite/units/fighter_units.yml` as the exemplar so future AI-generated unit YAMLs use the new per-doctrine level structure.

4. **Slot-aware research scheduling** — the optimizer currently treats research as single-threaded per unit (correct, since levels are sequential). To account for a country's second slot being occupied by another unit, `optimizeResearchSchedule` would need an `occupiedUntilHour` parameter.
