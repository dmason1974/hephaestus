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

**RHS (Force Projection — flip-point analysis complete, income accounting pending):** Given a target force, work backwards to find the optimal **flip point** per city — the moment each city stops queuing eco buildings and starts queuing military infrastructure (air_base upgrades, secret_lab, recruiting_office). The flip point determines how much eco income is captured before the city goes dark for construction, and when mobilisation capacity comes online. The flip-point sweep harness (`coalition-force-plan.ts`) now answers this per country across the full search space (all RO levels, all cities).

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

## Antarctica Elite Scenario — PNTH Coalition Force Plan

**Scenario parameters:**
- `truce_length_days: 28`
- `unlocked_through_day_at_start: 10` (shifts all unlock_day gates back by 10 days)
- Game starts day 1, hour 15
- Speed: `4x`

**Active coalition — PNTH V Road Jun 2026** (`data/scenarios/elite/antarctica/plans/pnth_v_road_2026_jun.yml`):

| Country | Doctrine | Status | Role |
|---|---|---|---|
| Indonesia | european | homeland | Air 1: 50 SASF + 18 UAV + 50 cruise missiles + 100 warheads |
| India | eastern | homeland | Air 2: 50 SASF + 10 AWACS |
| Russia | eastern | homeland | TDS: 40 TDS + 15 mobile radar + 15 commando (province) |
| Italy | european | homeland | MAAV: 100 MAAV |
| South Africa | european | homeland | MAAV: 100 MAAV |
| Madagascar | european | occupied | MAAV: 100 MAAV |
| Japan | western | homeland | MRL: 72 MRL + 27 MAAV + 1 Tank Veteran |
| Pakistan | western | homeland | MRL: 72 MRL + 27 MAAV + 1 Tank Veteran |
| Iran | eastern | occupied | MRL: 72 MRL + 27 MAAV + 1 Tank Veteran |
| Solomon Islands | european | occupied | Mech Inf: 40 Mech Inf + 20 CRV |

Resources are **shared across all coalition countries**.

### Coalition Force Plan YAML Schema (`domain: coalition_force_plan`)

Plan files live in `data/scenarios/<tier>/<scenario>/plans/`. Fields:

```yaml
schema_version: 1
domain: coalition_force_plan
name: <human-readable name>
scenario: elite/antarctica
truce_days: 28
resource_priority: [electronics, rares, components, fuel, supplies]  # coalition-level, highest priority first
search:
  top: 10
countries:
  <country_id>:
    status: homeland | occupied   # affects morale/production yield for all cities
    demands:
      - unitId: <unit_id>
        count: <n>
        mobilisation_source: province  # optional — commando and other province-mobilised units
```

**Key design decisions:**
- No `city_roles` field — city assignment is **optimizer output**, not YAML input. All cities are candidates for any role the optimizer needs; none are locked as eco.
- `resource_priority` is coalition-level (not split by queue type). Guides which cities to prefer flipping last (high-priority resource cities lose more eco income when flipped).
- `mobilisation_source: province` marks units that mobilise from provinces rather than city slots (commando). These don't compete for city mobilisation capacity and don't require recruiting offices.
- Warheads (`conventional_warhead`) have `batch_size: 4` — each mobilisation slot produces 4 units. They compete for the same city mobilisation slot as all other units. The slot is per-city, not per-building.
- `mercenary_outpost` must be built in the city build queue as a prerequisite for commando research/mobilisation.

### Mobilisation Model

**Every city has one mobilisation slot**, regardless of buildings. Buildings affect:
- **Recruiting office**: speeds up mobilisation (reduces time per unit)
- **Prerequisite buildings** (secret_weapons_lab, mercenary_outpost, army_base etc.): unlock research/mobilisation for specific unit types

RO L1 in every city is conventional practice (increases manpower income + speeds mobilisation from day 1). Whether it's strictly necessary in all cities is a question the optimizer should evaluate.

### Objective Function

```
Minimise: InfrastructureCost + MobilisationCost + UpkeepCost
```

Minimising cost maximises force projection: every resource saved on upkeep, over-built infrastructure, or surplus eco that can't be spent → more resources converted to units. Over-producing eco infrastructure when output exceeds coalition absorption capacity is wasteful (build queue time better spent on military infra).

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

| Gap | Status | Description |
|---|---|---|
| **Mobilisation cost missing from ranking** | ✅ Fixed | `compareOptions` now includes mobilisation cost in `totalEconomicCost`; upkeep and mobilisation costs were also silently zero due to per-doctrine record access bug — both fixed |
| **`secret_weapons_lab` not in build planner** | ✅ Fixed | `planInfrastructureForProfiles` detects the requirement from unit YAML, inserts the build step after the base chain and before `recruiting_office`; `secret_weapons_lab` added to `BuildingId` and engine simulation |
| **`arms_industry` level fixed at L1** | ✅ Fixed | `armsIndustryLevel` is now a search dimension alongside RO level and city count; default max is L1 (opt-in via `PLAN_MAX_AI_LEVEL` / `search.max_arms_industry_level`). Income from AI upgrades is now correctly modelled: `evaluateChoiceSet` runs a combined `simulateBuildOrder` over all cities with the force-plan build order and uses `dynamicHourlyIncomeFromSimulation`, matching the eco support path. Eco support candidate pruning also added: `arms_industry`/`air_base`/`naval_base` are only explored when they generate a resource currently in deficit; `underground_bunkers` and `relocate_headquarters` remain as candidates always (morale → production yield) |
| **Prerequisite research chains not threaded** | ✅ Fixed | `planMobilizationBuild` now passes mobilisation-start deadlines to the JIT scheduler; the dependency graph (`expandTargetsWithUnitRequirements` + task successor links) propagates constraints so ASF L1–L4 is scheduled before SASF L1 and completes before mobilisation opens |
| **No coalition shared resource pool** | ⬜ Open | Single-country only; no cross-country resource aggregation |
| **Flip point not modelled** | ✅ Solved (eco harness) | `src/engine/eco/flip-point-solver.ts` computes the latest safe flip point per city via iterative convergence; `src/harness/smoke/coalition-force-plan.ts` sweeps (city count × RO level) and reports eco hours captured per configuration |
| **Cross-queue city sharing not modelled** | ⬜ Open | A city assigned to SASF production and one assigned to AWACS are fully independent; the "switch mid-plan" pattern (AWACS during dead window → SASF after) is not found |

### Implementation Path

1. ✅ **Fix ranking** — mobilisation cost now in `totalEconomicCost`; per-doctrine cost access fixed throughout
2. ✅ **Add `secret_weapons_lab` to infrastructure build planner** — detects requirement from unit YAML, correct critical path for stealth ASF cities
3. ✅ **Thread prerequisite research chains** — `planMobilizationBuild` now passes `buildResearchDeadlineMap(scheduledGroups)` as `latestCompletionByUnitLevel`; the JIT backward scheduler propagates the constraint through the dependency graph (SASF L1 deadline → ASF L4 → L3 → L2 → L1), ensuring prerequisite research completes before mobilisation opens; infeasible plans (chain too long) return `null` so the planner retries with more cities
4. ✅ **Add `arms_industry` level as a search dimension** — `QueueChoice.armsIndustryLevel` + `QueueProfileSummary.armsIndustryTargetLevel`; `buildPlanActionsForCity` builds AI to the target level; search loops over 1..`maxArmsIndustryLevel` (default 1, overridable via `PLAN_MAX_AI_LEVEL` env var or `search.max_arms_industry_level` in plan YAML); display strings include `@AI{n}`; income from AI upgrades modelled correctly via `dynamicHourlyIncomeFromSimulation`; eco support candidate pruning by deficit resource
5. ✅ **Eco-first flip-point planner** — see Chunk 5 Architecture below; flip-point sweep complete; income accounting (steps 4-6 of two-pass algorithm) is the next chunk

---

## Chunk 5 Architecture — Eco-First Flip-Point Planner

### The Core Idea

The current harness always starts the military build chain on day 1, sacrificing all eco potential. The optimal plan has each city in eco mode until the latest possible moment, then flipping to military:

1. **Eco phase**: city runs beam-search optimal build order (arms_industry, air_base for production bonus, etc.)
2. **Flip point**: city switches from eco to military mode — derived, not searched
3. **Military phase**: city builds the remaining infra chain from where the eco phase left off
4. **Mobilisation phase**: units queue as soon as infrastructure is ready

The flip point is derived iteratively (not searched):

```
flipPoint = deadline − requiredMobilisationWindow − remainingInfraTime
```

Where `remainingInfraTime` is the delta between what the eco phase built and what the military chain requires. This is computed from the eco beam search's `BuildAction[]` timeline — if eco built `air_base L1→L2`, the military chain only needs `L2→L5`. Solved iteratively (1–2 rounds) to resolve the circular dependency.

### Key Design Decisions (settled)

- **No locked eco cities** — all cities are candidates for any military role. The optimizer assigns cities based on what the force plan requires. No city is protected as eco-only.
- **City assignment is optimizer output** — the YAML specifies demands per country, not which cities produce which units. The optimizer finds the cheapest city subset to flip.
- **Beam search extracted** — `src/engine/eco/city-eco-beam.ts` is the callable form; `buildingLevelsAtAbsHour(H)` is the key hook for the flip-point solver.
- **Single country first** — harness runs per-country; coalition aggregation is a future chunk.
- **Sweep, not search** — the harness sweeps all (city count × RO level) combinations and reports the flip-point matrix; city subset selection is currently simplified (capital-first ordering, not combinatorial). The full subset search is a future chunk.
- **Key empirical finding** — RO L5 is not always optimal. For 50 SASF across 7 cities, RO L3 captures more eco (278h) than RO L5 (271h) because the extra queue time for L4→L5 outweighs the mob window saving. The crossover is around 5–6 cities. Without RO L4/L5 in the search space this would not be visible.

### Two-Pass Algorithm

**Pass 1 — Eco pre-compute (per city, reused across search iterations):**
- Run city beam search for all country cities → `BuildAction[]` per city
- Store building levels achieved at each hour — needed to compute remaining infra delta at any flip point

**Pass 2 — Force footprint search:**
- For each candidate city subset and RO level:
  1. Compute `remainingInfraTime` from eco phase delta
  2. Derive `flipPoint` = deadline − mobilisationWindow − remainingInfraTime
  3. If flipPoint < game start: infeasible
  4. Income budget = eco income up to flipPoint (military cities) + full eco income (non-military cities) + starting balance
  5. Subtract infra cost + mobilisation cost + upkeep
  6. Report net shortfall by resource

### Harness — `coalition-force-plan.ts`

`src/harness/smoke/coalition-force-plan.ts` — run via `npm run smoke:coalition-force-plan`

- Reads `coalition_force_plan` YAML (default: `pnth_v_road_2026_jun.yml`)
- For each country (or one via `CFP_COUNTRY=<id>`): runs eco beam search for all cities
- Sweeps all city counts (1..N) × all RO levels (1..5) for each non-province demand
- Outputs HTML flip-point matrix: eco hours captured, remaining build chain, mob window per configuration
- Handles `batch_size` (warheads: 100 units = 25 mob events), launcher platforms (cruise missile: skipped), province demands (commando: skipped)
- **Still missing**: income budget vs. military cost accounting (steps 4-6 of the two-pass algorithm)

### What Needs Building

1. ✅ **Extract city beam search** → `src/engine/eco/city-eco-beam.ts` (exported callable `runCityEcoBeam`); includes `buildingLevelsAtAbsHour` per city
2. ✅ **Parse `coalition_force_plan` YAML** → `src/schemas/coalition-force-plan-schema.ts` + `src/scenarios/io/load-coalition-plan.ts`
3. ✅ **Flip point solver** → `src/engine/eco/flip-point-solver.ts`; iterative convergence with `buildingLevelsAtAbsHour`; handles batch_size (warheads), RO speed bonuses, per-city remaining chain
4. ✅ **New harness** → `src/harness/smoke/coalition-force-plan.ts`; sweeps all city counts × all RO levels (1–5) for each demand; outputs flip-point matrix + eco beam results per city; run via `npm run smoke:coalition-force-plan`
5. **Income accounting** — the two-pass algorithm steps 4-6: compute eco income up to flip point per city, subtract infra + mob + upkeep costs, report net resource shortfall by resource. This is the next chunk.
6. **Optimal city subset search** — currently the harness assigns cities in capital-first order. A combinatorial search over subsets (which N cities are cheapest to flip?) is needed for the true optimum.
7. **`mercenary_outpost` in build planner** → same pattern as `secret_weapons_lab`: detect from unit YAML requirements, insert in city infra chain (Russia/commando cities)
8. **Province mobilisation track** → commando (and future province units) excluded from city slot capacity; `mobilisation_source: province` in demand YAML (schema done, harness already skips province demands)

---

## Elite Unit Catalog Status

All elite units live in `data/scenarios/elite/units/`. As of the most recent session:

| Unit | Status | Notes |
|---|---|---|
| `stealth_air_superiority_fighter` | ✓ Complete | european + western + **eastern** (added); L1 only; requires `air_superiority_fighter level 4` + `air_base level 5` + `secret_weapons_lab level 1` |
| `air_superiority_fighter` | ✓ Complete | european + eastern + western; 7 levels |
| `awacs` | ✓ Complete | all doctrines; 6 levels |
| `uav` | ✓ Complete | all doctrines; 6 levels |
| `fixed_wing_veteran` | ✓ Complete | european + western; 7 levels |
| `theatre_defense_system` | ✓ Complete | western + european + eastern; 6 levels; mob/upkeep verified from screenshots; eastern mob/upkeep pending screenshots (unlock days derived: W=5,7,11,13,20,25 / Eu=6,8,12,15,20,28 / Ea=7,10,14,17,20,28) |
| `mobile_anti_air_vehicle` | ✓ Flat format | all doctrines (western + european + eastern); 7 levels |
| `multiple_rocket_launcher` | ✓ Complete | european + western + **eastern** (added); 5 levels |
| `mechanized_infantry` | ✓ All doctrines | western + european + eastern; 6 levels; values ported from standard — needs screenshot verification |
| `combat_recon_vehicle` | ✓ All doctrines | western + european + eastern; multi-level; armoured_units |
| `mobile_radar` | ✓ Present | all doctrines; support_units |
| `commando` | ✓ Present | all doctrines; seasonal_units; requires `mercenary_outpost level 1` + `special_forces level 1`; **province-mobilised** (not city slot) |
| `conventional_cruise_missile` | ✓ Present | all doctrines; missile_units; 0 mobilisation cost (launcher platform) |
| `conventional_warhead`, `chemical_warhead`, `nuclear_warhead` | ✓ Present | all doctrines; missile_units; `batch_size: 4` for warhead; uses city mobilisation slot |
| `airborne_infantry`, `motorized_infantry`, `special_forces` | ✓ Present | infantry_units |
| `tank_veteran` | ✓ Complete | all doctrines; multi-level; armoured_units |

