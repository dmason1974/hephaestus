# Hephaestus — Project Context

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
      research-schedule-optimizer.ts   Research schedule for a single unit (L1 ASAP, L2+ JIT)
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
        countries/            One YAML per country (coalition + AI nations)
```

**Unit catalog resolution order** (per scenario): scenario-local `units/` → tier-shared `units/` (e.g. `elite/units/`) → error if neither exists.

**Key data flow:**
`ForceProjectionOptimizer` → `optimizeResearchSchedule` (once, loop-invariant) → for each `MobilizationConfig`: `optimizeBatchAllocation` → `calculateTotalCost` → pick lowest-cost feasible solution.

---

## Key Domain Rules

- **Research slots**: the game allows 2 parallel research slots shared across all units. Levels of a single unit are always sequential (level N requires level N-1), but there are natural gaps between levels (unlock day windows) where other units' research can interleave. A level uses whichever slot is free first when it becomes ready — it is not sticky to the slot that ran the previous level.
- **Both slots are free at game start**: there is no slot contention at the beginning of a scenario.
- **Optimal research strategy**: research level 1 ASAP to unlock mobilisation, then defer levels 2+ as late as possible (JIT to the truce deadline). This minimises upkeep because higher-level units are mobilised close to the deadline and pay less upkeep before the game ends.
- **`unlocked_through_day_at_start`**: shifts all unlock gates back by N days. Formula: `effectiveUnlockDay = Math.max(1, unlockDay - unlockedThroughDayAtStart)`. So with value 10: unlock_day 1–11 all become available on day 1, unlock_day 12 becomes day 2, etc.
- **Prerequisite research is still required**: unlock day shifting does not bypass the research chain.
- **Resource costs are sparse**: YAML cost blocks only list non-zero resources. The schema makes all resource fields optional.
- **`ResourceCost` type** is `Partial<Record<Resource, number>>` — absent key means zero, not unknown.
- **Country doctrine**: each country has a single doctrine (e.g. `european`, `western`). Research times, research costs, mobilisation times, mobilisation costs, and daily upkeep all vary by doctrine. The `doctrine` field on a unit is an array (1–3 values) listing which doctrines can use it.

---

## Country YAML Schema

One file per country under `data/scenarios/<tier>/<scenario>/countries/<id>.yml`. Fields:

```yaml
version: 1

country:
  id: norway               # snake_case, matches filename
  name: Norway             # display name
  doctrine: western        # western | eastern | european

cities:
  - id: oslo
    name: Oslo
    capital: true          # exactly one city per country must be capital: true
    resource: fuel         # supplies | components | fuel | rares | electronics
    population: 6          # 4 | 5 | 6
    starting:
      air_base: 1          # 1 if the city has an Air Base, else 0
      naval_base: 0        # 1 if the city has a Harbor, else 0
      underground_bunkers: 0  # always 0 at scenario start
```

**Key rules:**
- `underground_bunkers` is always `0` at scenario start — no country begins with bunkers.
- The capital city is the one with the HQ building in-game (`capital: true`). Capital cities also tend to have `air_base: 1` but this is not universal (e.g. South Africa's Cape Town has no naval base).
- Resource amounts in-game vary by resource type and population tier but are not stored in the YAML — only the resource type is recorded.
- Single-city "AI nations" (e.g. Solomon Islands, Oman) follow the same schema with one city entry.

---

## Scenario YAML — `coalition` Field

The scenario file supports an optional `coalition` list of country IDs identifying which countries are on our team:

```yaml
coalition:
  - argentina
  - australia
  - ...
```

This is currently a flat list. Role distinctions (active player vs captured vs AI ally) are deferred — the field exists to record membership.

---

## Unit YAML Schema — Per-Doctrine Level Structure

Unit levels store costs and timings keyed by doctrine. `unlock_day` lives **inside each doctrine's research block** (it is per-doctrine). `requirements` is shared and lives at the level root. Example:

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
      research:
        european:
          unlock_day: 1
          time: { hours: 22, minutes: 30 }
          cost: { supplies: 1800, rares: 1900, cash: 4000 }
        western:
          unlock_day: 1
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

**Backwards compatibility**: three YAML formats are auto-normalised on parse:
1. Old flat format (`research: { unlock_day, time, cost }` at root) — spread into per-doctrine blocks
2. Transitional format (`unlock_day` at level root, per-doctrine research without it) — `unlock_day` injected into each doctrine's research block
3. Current format (`unlock_day` inside each doctrine's research block) — no transformation needed

**Partial doctrine data is valid**: a unit may have data for only some of its doctrines at some levels (e.g. levels 2–7 may only have `western` data while `european` screenshots are pending).

---

## Engine Layer — Doctrine Parameter

All engine functions that read per-level costs or timings accept a `doctrine: string` parameter. The doctrine is sourced from `country.country.doctrine` at the top level and threaded down:

- `ResearchScheduleInput.doctrine` → `optimizeResearchSchedule`
- `BatchAllocationInput.doctrine` → `optimizeBatchAllocation`
- `FilterFeasibleConfigsArgs.doctrine` → `filterFeasibleConfigs`
- `calculateTotalCost`, `calculateMobilizationCost`, `calculateUpkeepCost`, `calculateMobilizationDuration`, `calculateCompletionHour` — all take `doctrine: string` as an explicit parameter
- `simulateUnitResearchQueue`, `simulateUnitResearchTargets`, `determineMaximumFeasibleLevel` — accept `doctrine?` in opts; fall back to `unit.doctrine[0]` per unit when not provided
- `planMobilizationBuild` — accepts `doctrine?` in args; falls back per unit

---

## Research Scheduling Strategy

`optimizeResearchSchedule` uses a two-pass approach:

1. **ASAP feasibility pass** — determines which levels can be achieved before the deadline (sequential ASAP scheduling, same as before).
2. **Scheduling pass** — level 1 is placed ASAP to unlock mobilisation as early as possible; levels 2+ are placed JIT by working backwards from the deadline. Each level is pushed as close to the deadline as its unlock day and sequential dependency allow.

`simulateUnitResearchTargets` (used by `planMobilizationBuild`) also implements JIT scheduling with the same intent, handling multi-unit plans across both research slots.

---

## The Ultimate Goal — Coalition Force Projection Optimizer

The project's end goal is a **coalition-wide JIT force projection optimizer** for the elite Antarctica scenario. The primary use case is: given a 10-country coalition with a **shared resource pool** and a 28-day truce, find the minimum-cost build sequence for every city in every country such that the coalition's full target force is ready by the deadline and the shared economy never goes insolvent.

### Problem Decomposition: LHS vs RHS

**LHS (Economy — largely solved):** Given N eco-build days, what resource flow does the coalition generate? The city and country beam search harnesses (`elite-ww3-city-beam-search.ts`, `elite-ww3-country-beam-search.ts`) answer this per country.

**RHS (Force Projection — work in progress):** Given a target force, work backwards to find the optimal **flip point** per city — the moment each city stops queuing eco buildings and starts queuing military infrastructure (air_base upgrades, secret_lab, recruiting_office). The flip point determines how much eco income is captured before the city goes dark for construction, and when mobilisation capacity comes online.

The two sides are coupled: eco income funds the military build, and the flip point is the join. The optimal flip point is different per city, per country, and is interdependent across the coalition because of the shared resource pool.

### Objective Function

```
TotalCost = InfrastructureCost + MobilisationCost + UpkeepCost
```

- **InfrastructureCost** — all building spend in military-mode cities (air_base, secret_lab, arms_industry, recruiting_office). One-time, paid when each building completes.
- **MobilisationCost** — per-unit resource spend when each mobilisation starts. Varies by level mobilised at (see auto-upgrade mechanic below).
- **UpkeepCost** — `Σ units × upkeep(level(t)) × hoursBeforeDeadline`. Stepped by research level completions because units auto-upgrade as research progresses.

Subject to: all target units mobilised by deadline; coalition shared resource pool never goes negative at any hour.

### Key Domain Insight — Auto-Upgrade Mechanic

Units mobilised at level 1 **automatically upgrade** as higher research levels complete. This means:
- Always mobilise at level 1 ASAP (lowest mobilisation cost, fastest production)
- Research runs in background; units step up through levels for free
- Upkeep cost is a **stepped function** keyed to the research schedule, not a flat rate
- The current engine models upkeep at a fixed rate per mobilised level — this is a known gap

### Key Domain Insight — Flip Point and Arms Industry Trade-off

Each city's build queue has a single sequential slot. The critical path to SASF production (for example) is:
```
arms_industry L1 (9h) → air_base L2→L5 (116h) → secret_weapons_lab (25h) → ro2+ro3 (54h)
```
Total: ~204h from game start for a capital city (starting air_base 1) before SASF mobilisation can begin.

Building `arms_industry` to higher levels before the air_base chain generates more resource income earlier, but delays the military build and shrinks the mobilisation window. The number of units a city can produce is directly proportional to `(deadline - mobilisationStartHour) / mobilisationTimePerUnit`. This trade-off is the core design variable the optimizer must solve per city.

A city producing electronics (e.g. Jakarta) benefits more from early arms_industry upgrades than a supplies city, but the SASF production loss from delaying the air_base build is always larger than the resource gain from early arms_industry (for typical city production rates). The optimizer must compute this correctly per city rather than applying a blanket rule.

### Dead-Window AWACS Production

When a city is building air_base L5 (32h) and then secret_weapons_lab (25h) in sequence (~57h dead window), that city's **mobilisation queue runs in parallel** and can produce AWACS during this period — AWACS only requires air_base L4. This yields approximately 3 AWACS per SASF production city during the dead window at no opportunity cost, provided AWACS L1 research is already complete.

---

## Antarctica Elite Scenario — Coalition Force Plan

**Scenario parameters:**
- `truce_length_days: 28`
- `unlocked_through_day_at_start: 10` (shifts all unlock_day gates back by 10 days)
- Game starts day 1, hour 15
- Speed: `4x`

**Coalition countries (12 total, 10 active players):**
```
argentina (western), australia (western), indonesia (european),
italy (european), japan (western), new_zealand (european),
norway (western), pakistan (western), russia (eastern),
south_africa (european), ukraine (eastern), united_kingdom (european)
```

**Target force composition (across coalition):**
- 3 countries: MRL + MAAV builds
- 1 country: SASF + UAV (50 stealth ASF, AWACS support)
- 1 country: SASF + AWACS
- 3 countries: MAAV build only
- 1 country: Mech Inf + Combat Recon Vehicle
- 1 country: Theatre Defense System
- 1 air-build country: cruise missile warheads alongside air units

Resources are **shared across all coalition countries**. Eco-specialist countries (particularly Russia and Ukraine with eastern doctrine) contribute resource generation throughout the 28 days while military-production countries flip their cities to unit production.

---

## Existing Harness — `force-build-plan.ts`

The primary planning harness in `src/harness/smoke/force-build-plan.ts` already does much of the RHS work for a **single country**:
- Exhaustive search over city-count × recruiting_office-level combinations per unit queue type
- JIT research scheduling across both research slots
- Per-city infrastructure build planning (air_base, army_base, recruiting_office)
- Full affordability checking against real cash flow (income + starting balance)
- Beam search eco-support pass when the plan is unaffordable

Invoke via YAML force plan file or env vars (`PLAN_COUNTRY`, `PLAN_DEMANDS`, `PLAN_TRUCE_DAYS`, etc.).

### Known Gaps in the Current Harness

| Gap | Description |
|---|---|
| **Mobilisation cost missing from ranking** | `compareOptions` ranks by `infrastructureCost + upkeepCost` but excludes mobilisation cost — units mobilised at different levels look equal to the ranker |
| **`arms_industry` level fixed at L1** | `buildPlanActionsForCity` always builds arms_industry to L1 only; higher levels are never in the search space |
| **`secret_weapons_lab` not in build planner** | For units requiring secret_weapons_lab (e.g. stealth ASF), the infrastructure build plan omits this building and therefore produces wrong timing |
| **Prerequisite research chains not threaded** | The research scheduler handles a unit's own level chain but not unit-to-unit prerequisites (e.g. stealth ASF requires ASF L1–L4 to be researched first) |
| **No coalition shared resource pool** | Single-country only; no cross-country resource aggregation |
| **Flip point not modelled** | City transitions from eco to military mode implicitly on day 1; there is no search over when to make that transition |
| **Cross-queue city sharing not modelled** | A city assigned to SASF production and one assigned to AWACS are fully independent; the "switch mid-plan" pattern (AWACS during dead window → SASF after) is not found |

### Implementation Path (next session)

1. **Fix ranking** — include mobilisation cost in `totalEconomicCost` in `compareOptions` (one-line fix, high correctness impact)
2. **Add `secret_weapons_lab` to infrastructure build planner** — detect when the target unit requires it and insert into the city build queue
3. **Thread prerequisite research chains** — the research scheduler needs to know that stealth ASF requires ASF L4 first; chain these via the unit's `requirements` field
4. **Add `arms_industry` level as a search dimension** — vary L1–L5 per city alongside RO level; evaluate cost vs delayed production window
5. **Coalition wrapper** — pool resources across N country simulations, allocate unit production to countries, optimise flip points jointly using the existing single-country harness as the inner evaluator

---

## Elite Unit Catalog Status

All elite units live in `data/scenarios/elite/units/`. As of the most recent session:

| Unit | Status | Notes |
|---|---|---|
| `stealth_air_superiority_fighter` | ✓ Complete | european + western; L1 only (max level); requires `air_superiority_fighter level 4` + `air_base level 5` + `secret_weapons_lab level 1` |
| `air_superiority_fighter` | ✓ Complete | european + western; 7 levels |
| `awacs` | ✓ Complete | all doctrines; 6 levels |
| `uav` | ✓ Complete | all doctrines; 6 levels |
| `fixed_wing_veteran` | ✓ Complete | european + western; 7 levels |
| `theatre_defense_system` | ✓ Complete | western + european + eastern; 6 levels; mob/upkeep verified from screenshots; eastern mob/upkeep pending screenshots (unlock days derived: W=5,7,11,13,20,25 / Eu=6,8,12,15,20,28 / Ea=7,10,14,17,20,28) |
| `mobile_anti_air_vehicle` | ✓ Flat format | Western doctrine; 7 levels |
| `multiple_rocket_launcher` | ✓ Flat format | Western doctrine; 5 levels |
| `mechanized_infantry` | ⚠️ Ported | european; 6 levels; values ported from standard — needs screenshot verification |
| `combat_recon_vehicle` | ⚠️ Stub | Structural placeholder only — no cost/time data; needs screenshots |
| `conventional_cruise_missile` | ✓ Present | missile_units |
| `conventional_warhead`, `chemical_warhead`, `nuclear_warhead` | ✓ Present | missile_units |
| `airborne_infantry`, `motorized_infantry`, `special_forces` | ✓ Present | infantry_units |

