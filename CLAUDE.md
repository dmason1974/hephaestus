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

starting_balance:          # optional; present on all 7-city (playable) countries
  supplies: 35748          # per-country starting resources — same for all coalition members
  components: 26810        # only realised when country is actively played (status: homeland)
  fuel: 13406              # occupied/AI nations contribute 0 to the coalition pool
  rares: 9830
  electronics: 9830
  cash: 134062
  manpower: 13406          # NOTE: manpower is NOT pooled — must be checked per-country
```

**Key rules:**
- `underground_bunkers` is always `0` at scenario start — no country begins with bunkers.
- The capital city is the one with the HQ building in-game (`capital: true`). Capital cities also tend to have `air_base: 1` but this is not universal (e.g. South Africa's Cape Town has no naval base).
- Resource amounts in-game vary by resource type and population tier but are not stored in the YAML — only the resource type is recorded.
- Single-city "AI nations" (e.g. Solomon Islands, Oman) follow the same schema with one city entry.
- `starting_balance` is a **per-country** value present on all 7-city (playable) countries. The coalition pool for pooled resources = sum across all `homeland` countries. Occupied and AI-nation countries contribute 0. All 26 seven-city country YAMLs in the Antarctica scenario carry this field.

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

**LHS (Economy — largely solved):** Given N eco-build days, what resource flow does the coalition generate?

Two harnesses serve different purposes:
- **`elite-ww3-city-beam-search.ts`** — per-city optimal eco path, each city optimised independently without reference to country balance. This is the correct tool for defining per-city optimal build orders. Run with `BS_CITY=all` to sweep all cities in one pass.
- **`elite-ww3-country-beam-search.ts`** — global resource flow validation: given a shared country pool, what sequence of builds across all cities maximises total resource output? Answers a different question from the city search; useful for validating that a combined plan is self-funding. Produces three HTML files: ranking (`BSC_OUTPUT_FILE`), winning build plan (`BSC_PLAN_FILE`), and eco projection (`BSC_ECO_FILE`). Supports comma-separated `BSC_HQ_CITY` for multi-city HQ relocation candidates.

**Eco planning workflow (settled architecture):**
1. Run city beam search per city → per-city optimal `BuildAction[]` timeline
2. Force projection determines flip point per city (latest moment city can switch from eco to military and still hit deadline)
3. Trim eco plan at flip point; drop AI upgrades on resources the force plan doesn't consume
4. Overlay all per-city plans on the shared country pool → affordability check (report shortfall by resource and hour)

**Eco score weights** — beam search score weights should be derived from the force projection's resource footprint: `weight[resource] = Σ mobilisation_cost[resource] × count + Σ daily_upkeep[resource] × count × remaining_days`. This aligns eco optimization with what the force plan actually consumes. **Force projection code owns this computation; eco beam search consumes weights as input** (via env vars or config). This is not yet implemented — current weights are hardcoded (all resources = 1.0 except cash/manpower = 0.25).

**RHS (Force Projection — flip-point analysis and per-country income accounting complete):** Given a target force, work backwards to find the optimal **flip point** per city — the moment each city stops queuing eco buildings and starts queuing military infrastructure (air_base upgrades, secret_lab, recruiting_office). The flip point determines how much eco income is captured before the city goes dark for construction, and when mobilisation capacity comes online. The flip-point sweep harness (`coalition-force-plan.ts`) now answers this per country across the full search space (all RO levels, all cities), with full income accounting (eco income vs infra + mob + upkeep costs) per matrix row. Coalition-level aggregation (summing all countries against the shared pool) is chunk 7.

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
| New Zealand | european | homeland | MAAV: 100 MAAV |
| Japan | western | homeland | MRL: 72 MRL + 27 MAAV + 1 Tank Veteran |
| Pakistan | western | homeland | MRL: 72 MRL + 27 MAAV + 1 Tank Veteran |
| Australia | western | homeland | MRL: 72 MRL + 27 MAAV + 1 Tank Veteran |
| Norway | western | homeland | Mech Inf: 40 Mech Inf + 20 CRV |
| United Kingdom | european | occupied | Eco only (captured player country) |
| Iran | eastern | occupied | Eco only (captured AI nation, single city) |
| Madagascar | european | occupied | Eco only (captured AI nation, single city) |
| Solomon Islands | european | occupied | Eco only (captured AI nation, single city) |

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
5. ✅ **Eco-first flip-point planner** — see Chunk 5 Architecture below; flip-point sweep complete
6. ✅ **Income accounting (chunk 6)** — per-row: eco income (military cities capped at flip point then flat rate; eco cities full), infra cost, mob cost (L1), upkeep cost (L1 rate); net balance per resource with shortfall/surplus; coalition starting balance shown in header separately
7. ✅ **Coalition aggregation (chunk 7)** — for each country, best feasible row per demand (most eco hours captured); per-city flip = min across all demands using that city (prevents income double-counting); coalition balance sheet (pooled resources only) + per-country manpower check + per-demand city queue tables in HTML. Starting balance summed from per-country YAML values for homeland countries only. Only runs with `CFP_COUNTRY=all`. **OOM note**: full run (beam_width=50) requires `--max-old-space-size=8192` for 14 countries.

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
- Handles `batch_size` (warheads: 100 units = 25 mob events), launcher platforms (cruise missile: skipped), province demands (commando: skipped)
- Per-row income accounting: eco income (with post-flip flat-rate extrapolation), infra/mob/upkeep costs, net resource balance, affordable/shortfall summary
- `countryStatus` (homeland/occupied) correctly flows into city morale for eco beam (bug fixed chunk 6)
- **Chunk 7 complete**: coalition-level aggregation across all countries against the shared pool — coalition balance sheet (pooled resources) + per-country manpower check
- **Chunk 8 complete**: HTML output restructured for human readability (see below)

**HTML output modes (chunk 8):**

*Coalition run (`CFP_COUNTRY=all`)*: aggregate-only HTML — scenario parameters + Best-Pick Summary table + Coalition Balance Sheet (pooled resources only; net row in red/green).

*Single-country run (`CFP_COUNTRY=<id>`)*: per-country HTML with 5 sections per military country:
1. **Demands — Selected Configurations** — best flip config per demand (most eco hours captured)
2. **Country Balance Sheet** — all 7 resources including manpower (manpower labelled as not pooled); net row red/green
3. **Research Plan** — L1 ASAP for each demand unit (Slot 1/2 assignment; correct start/complete times)
4. **City Build Plans** — one row per city; military cities show numbered eco steps completed before flip → `→ FLIP: day X` → remaining infra chain; eco cities show full beam sequence; where multiple demands share a city the earliest flip determines the shown sequence
5. **Mobilisation** — consolidated table: one row per city, one column per demand (`~N units` or `—`); no resource column

Eco-only countries (UK, Iran, Madagascar, Solomon Islands) show only their balance sheet (eco income, no military sections).

### What Needs Building

1. ✅ **Extract city beam search** → `src/engine/eco/city-eco-beam.ts` (exported callable `runCityEcoBeam`); includes `buildingLevelsAtAbsHour` per city; `hourlyCityProduction` array added for income accounting
2. ✅ **Parse `coalition_force_plan` YAML** → `src/schemas/coalition-force-plan-schema.ts` + `src/scenarios/io/load-coalition-plan.ts`
3. ✅ **Flip point solver** → `src/engine/eco/flip-point-solver.ts`; iterative convergence with `buildingLevelsAtAbsHour`; handles batch_size (warheads), RO speed bonuses, per-city remaining chain
4. ✅ **New harness** → `src/harness/smoke/coalition-force-plan.ts`; sweeps all city counts × all RO levels (1–5) for each demand; outputs flip-point matrix + eco beam results per city; run via `npm run smoke:coalition-force-plan`
5. ✅ **Income accounting** — per-row: eco income (military cities capped at flip then flat rate; eco cities full), infra cost, mob cost (L1), upkeep cost (L1 rate), net balance per resource
6. ✅ **Coalition aggregation (chunk 7)** — run all countries, sum eco income and costs into one balance sheet against the shared starting pool; identify binding resource constraints across the full coalition
7. **Optimal city subset search** — currently capital-first ordering; combinatorial search over which N cities to flip is needed for the true optimum
8. **`mercenary_outpost` in build planner** → same pattern as `secret_weapons_lab`: detect from unit YAML requirements, insert in city infra chain (Russia/commando cities)
9. **Province mobilisation track** → commando excluded from city slot capacity; `mobilisation_source: province` in demand YAML (schema done, harness already skips province demands)

---

## Chunk 7 Architecture — Coalition Aggregation ✅ COMPLETE

### What Was Built

`computeCoalitionSummary` in `coalition-force-plan.ts`:
- For each country demand, selects the best feasible flip-point row (most eco hours captured; fewest cities as tiebreaker).
- Multi-demand countries: per-city flip = min flip across all demands using that city, preventing income double-counting.
- Eco-only countries (UK, Iran, Madagascar, Solomon Islands): contribute full 28-day eco income (no flip).
- Sums eco income + costs across all countries; coalition starting balance = sum of per-country `starting_balance` for `homeland` countries only.
- HTML output: per-demand city queue tables (eco phase → military build chain → mob), coalition balance sheet (pooled resources only), per-country manpower check.

### Resource Pooling Rules

- **Pooled resources** (`POOLED_RESOURCES` in `src/core/constants.ts`): supplies, components, fuel, rares, electronics, cash — shared across the coalition pool.
- **Non-pooled resources** (`PER_COUNTRY_RESOURCES`): manpower — country-specific, cannot be transferred. Checked per-country separately in the HTML output.
- Coalition balance sheet only shows pooled resources. Manpower has its own "Per-Country Manpower Check" table.

### Known Limitations

- **Best-row selection is independent per demand**: for multi-demand countries (e.g. Indonesia SASF+UAV+warheads), the "best UAV row" shows 636h eco but those cities are already constrained to flip at 278h by SASF. The balance sheet is computed correctly (using per-city flip), but the per-demand flip shown in the config table can be misleading.
- **Capital-first city ordering**: not optimal; combinatorial city-subset search is future work.
- **OOM fixed**: coalition contribution now computed inline in `analyseCountry` (cityResults not retained); `--max-old-space-size=8192` baked into npm script as safety net for single-country beam peaks.
- **Eco buildings at flip are worst-city only**: `ecoBuildingsAtFlip` in city queue tables shows the state of the constrained (worst) city; other assigned cities may have more eco buildings at the same flip point.

### Corrected Coalition Results (beam_width=50)

Starting balance = per-country value × 10 homeland countries (pooled resources); manpower per-country.

```
                  supplies    components    fuel      rares     electronics  cash
Total eco income  1,417,743   1,176,534   690,474   408,327   506,063      3,905,547
+ Starting bal      357,480     268,100   134,060    98,300    98,300      1,340,620
= Gross available 1,775,223   1,444,634   824,534   506,627   604,363      5,246,167
− Infra cost        372,250     294,150   405,250    46,500   237,875      1,661,475
− Mob cost          816,750     684,100    12,500    67,500   391,850      1,759,875
− Upkeep cost       291,421         428   192,455         0    63,282        668,974
= Net balance      +294,802    +465,956  +214,329  +392,627   -88,644     +1,155,843
```

**Single binding pooled shortfall: electronics (−88,644).** All other pooled resources surplus.

Manpower per-country (eco income + 13,406 starting − mob − upkeep):
- Russia, UK: surplus. All other homeland countries: shortfall ~−11k to −25k each.
- Manpower shortfall is structural (driven by mob + upkeep costs exceeding eco income + starting).
  Cannot be fixed by eco optimization; must reduce unit counts or accept the shortfall.

### Next Steps (Chunk 9+)

- **Joint demand optimisation per country**: treat multi-demand countries as a single optimisation problem (shared city pool)
- **Optimal city subset search**: combinatorial rather than capital-first ordering
- **`mercenary_outpost` in build planner**: Russia/commando cities need it in the infra chain
- **Province mobilisation costs**: commando mob cost not yet included in balance sheet
- **Electronics shortfall (−88k)**: investigate which demands/countries drive it; consider reducing UAV count or finding an electronics eco city that can stay longer

---

## Chunk 8 — HTML Output Restructuring ✅ COMPLETE

### What Was Built

`renderHtml` in `coalition-force-plan.ts` restructured for human readability. Two distinct rendering modes based on whether `CFP_COUNTRY=all` or a single country.

**New helper functions:**
- `htmlBalanceSheet(rows, netRowLabel, resources)` — renders a labelled balance-sheet table; net row cells are coloured red (shortfall) or green (surplus) via inline style
- `ecoStepsAtFlip(timedOrderLines, ecoBuildingsAtFlip)` — filters the full eco beam sequence to only steps completed by flip, using `ecoBuildingsAtFlip` as ground truth; renumbers to avoid gaps
- `militaryBuildSequence(timedOrderLines, ecoBuildingsAtFlip, flipDay, remainingChain, remainingBuildHours)` — assembles the full "build sequence" cell: eco steps → `→ FLIP: day X` → remaining infra chain with build hours
- `parseFormattedNumber` / `parseEcoBuildingsMap` — parsing helpers

**Research plan L1-ASAP scheduling:**

`simulateUnitResearchTargets` with `enableJitScheduling: false` by itself does NOT produce ASAP scheduling — the backward scheduler still places all tasks as late as possible relative to the deadline.

To force L1 ASAP, compute `latestCompletionByUnitLevel` per unit and pass it in opts:
```typescript
const dur = Math.ceil(durationToHours(level1Research.time));  // must ceil to match sim's normalization
latestCompletionByUnitLevel[`${uid}:1`] = unlockAbsHour + dur;
```
`unlockAbsHour` = `effectiveUnlockDay <= scenario.start.day ? scenarioAbsHour : toAbsoluteHour(effectiveUnlockDay, 0)`.
The constraint forces the backward scheduler to place L1 at exactly `releaseHour` (ASAP). **Critical**: use `Math.ceil` on the raw `durationToHours` result — the sim normalises durations with `Math.ceil` internally; without it the constraint is off by the fractional hour and the task fails the feasibility check and is silently skipped.

Required imports added to harness:
- `toAbsoluteHour` from `../../core/time.js`
- `scenarioResearchUnlockedThroughDayAtStart` from `../../schemas/scenario-schema.js`

**City constraint map:**

For countries with multiple demands sharing cities, the city build sequence shown is determined by the demand with the earliest `flipRelHour`:
```typescript
const cityConstraint = new Map<number, FlipMatrix>();
for (const cfg of activeCfgs) {
  for (let i = 0; i < cfg.row!.numCities; i++) {
    const prev = cityConstraint.get(i);
    if (!prev || cfg.row!.flipRelHour < prev.flipRelHour) cityConstraint.set(i, cfg.row!);
  }
}
```

### Known Limitations

- **`ecoBuildingsAtFlip` is worst-city only**: the eco steps shown for all assigned cities reflect the constrained (worst) city's state at flip; other cities may have more eco buildings completed at the same flip point
- **Research plan shows L1 only**: higher levels are not shown since optimal level depends on final force planning decisions not yet made
- **Flip-point matrix removed from per-country HTML**: still printed to terminal; redundant in the country HTML given the Demands section already shows the selected config

---

## Elite Unit Catalog Status

All elite units live in `data/scenarios/elite/units/`. As of the most recent session:

| Unit | Status | Notes |
|---|---|---|
| `stealth_air_superiority_fighter` | ✓ Complete | european + western + **eastern** (added); L1 only; requires `air_superiority_fighter level 4` + `air_base level 5` + `secret_weapons_lab level 1` |
| `air_superiority_fighter` | ✓ Complete | european + eastern + western; 7 levels; eastern = european baseline (placeholder pending screenshots) |
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

---

## Modular Architecture — Three-Unit Rebuild

The coalition force projection engine is being rebuilt as three discrete, independently-runnable units. Each unit has a clean data contract and can be tested in isolation.

```
Unit 1 — Eco Planner                    ✅ COMPLETE
  Input:  scenario, country (resource, population, starting buildings, status)
  Output: EcoPlan — optimal eco build sequence per city, hourly production array
  Question: "What is the best economy this city can achieve over the full truce window?"

Unit 2 — Force Projection               ⬜ NEXT
  Input:  coalition_force_plan YAML, eco plans from Unit 1 (for flip-point derivation)
  Output: per-country flip points, research schedule, city build plans, mob tables
  Question: "Given our demands and eco baseline, when does each city flip to military, and what does it build?"

Unit 3 — Resource Projection            ⬜ FUTURE
  Input:  Unit 1 eco plans + Unit 2 force plans + coalition starting balances
  Output: hourly coalition resource flows, net balance per resource, shortfalls
  Question: "Can the coalition afford this combined plan? Where does it go insolvent?"
```

---

## Unit 1 — Eco Planner ✅ COMPLETE

### What Was Built

`src/harness/smoke/eco-plan.ts` — standalone eco harness, `npm run smoke:eco-plan`.

Writes `tmp/eco-<countryId>.html` per country. Three sections per country:
1. **City Eco Build Plans** — step-by-step build sequence per city with day/hour timestamps
2. **City Production Summary** — total resource flow per city over the full truce window (gross, no flip)
3. **Eco Build Costs** — one-time resource costs for all eco builds

**Run syntax:**
```
ECO_SCENARIO=elite/antarctica ECO_COUNTRY=all npm run smoke:eco-plan    # all countries, no plan required
ECO_COUNTRY=norway npm run smoke:eco-plan                                # single country
ECO_PLAN=pnth_v_road_2026_jun ECO_COUNTRY=all npm run smoke:eco-plan    # coalition members only
ECO_BEAM_WIDTH=50 ECO_TOP_N=3 ECO_COUNTRY=indonesia npm run smoke:eco-plan
```

**Config env vars:** `ECO_SCENARIO` (default: `elite/antarctica`), `ECO_PLAN` (optional — narrows country list to coalition members), `ECO_COUNTRY` (default: `all`), `ECO_BEAM_WIDTH` (default: 50), `ECO_TOP_N` (default: 3).

### Key Design Decisions

- **Unconstrained mode** (`unconstrained: true` in `CityEcoBeamConfig`): no affordability check — each build is scheduled at the earliest free hour. Score = `endBalance[city.resource]` (native resource net of costs). This ensures every city gets a real plan regardless of starting balance.
- **No resource weights**: coalition weights distorted the beam (cash weight=1.0 made AI L4-5 score-negative). Eco planner is purely single-resource — it doesn't know or care about coalition demand.
- **`annex_city` for occupied cities**: candidate pool includes `annex_city` for occupied; excludes it for homeland. All occupied cities always build annex first (production doubles 25%→50%; always ROI-positive over the ~600h window).
- **`recruiting_office` always in pool**: for all cities. L1 RO is 30 min and gives manpower bonus from that hour.
- **Status from country YAML**: `country.country.status` (`homeland` | `occupied`, default `homeland`). Not read from the force plan YAML — eco planner is plan-independent.
- **Country list without a plan**: scans `data/scenarios/<scenarioId>/countries/*.yml` via `fs.readdirSync`.
- **Truce days without a plan**: from `scenarioTruceLengthDays(scenario)` (falls back to 28 if absent from scenario YAML).

### Scoring Behaviour

Beam stops adding buildings when no remaining build provides net positive return in the native resource. Cross-resource costs (e.g. air_base L3 costs components/electronics but Oslo only produces fuel) are borne by the score — only the native-resource component matters. Cities stop early because the pool is finite and late-game builds stop paying back: Oslo (fuel, pop-6) stops at AI L5 + air_base L2 + hospital because air_base L3's extra +5% fuel production over ~460h comes in just under the 2000 fuel cost.

### Country YAML — `status` Field

```yaml
country:
  id: solomon_islands
  name: Solomon Islands
  doctrine: european
  status: occupied    # homeland (default) | occupied
```

Four Antarctica occupied countries have `status: occupied`: `united_kingdom`, `iran`, `madagascar`, `solomon_islands`.

---

## Unit 2 — Force Projection ⬜ NEXT

**Goal**: given a `coalition_force_plan` YAML and the eco plans from Unit 1, produce per-country force plans — flip points, research schedules, city build sequences, mobilisation tables.

### What it must produce (per country)

1. **Flip point per city** — when each city transitions from eco to military mode (derived from `flipPoint = deadline − mobWindow − remainingInfraTime`)
2. **Research schedule** — JIT for all levels (L1 ASAP only if required for mob before deadline)
3. **City build plan** — eco steps completed before flip → military infra chain → recruiting office
4. **Mobilisation table** — units per city per demand, timing

### Key inputs

- `coalition_force_plan` YAML (demands per country)
- Eco plans from Unit 1 via `runCityEcoBeam` → `buildingLevelsAtAbsHour(H)` per city
- Scenario (truce days, start hour, unlock credit)
- Buildings and unit YAML data

### Relationship to existing code

`src/engine/eco/flip-point-solver.ts` already computes flip points given a demand.
`src/harness/smoke/coalition-force-plan.ts` already does most of this per-country sweep — Unit 2 will reorganise it into a clean callable function rather than an HTML harness, so the outputs can be composed with Unit 3.

### Design constraints

- Province demands (`mobilisation_source: province`) are excluded from city slot accounting — commando doesn't compete for city capacity
- Batch units (`batch_size: 4` for warheads) — 100 warheads = 25 mob events
- Launcher platforms (cruise_missile) have zero mob cost and are skipped for city slot
- `mercenary_outpost` must appear in city infra chain for commando cities (Russia) — same pattern as `secret_weapons_lab`
- Multi-demand countries: per-city flip = min across all demands sharing that city

---

## Post-UAT Task List

Tasks deferred until after UAT of the current coalition force plan engine output.

### Testing

1. **Strengthen morale tests** — current coverage is thin (3 tests, ~5 assertions). Add: occupied city morale curve, assertions anchored to real day-1 and day-28 values, edge cases for the D (decay) parameter.

2. **Anchored production test** — add one test that chains the full morale × population → hourly output stack to a known real-world value. Example: pop-6 homeland supplies city, day 1, 4x speed, no buildings → assert exact hourly output. Guards against silent regressions in the core production formula.

3. **Engine regression test** — run `coalition-force-plan` harness on the PNTH plan and assert key numeric outputs: no NaN values, all non-province demands feasible, electronics net balance in expected range (currently −88k). Catches silent regressions in the flip-point solver and coalition aggregation without requiring human HTML review.

4. **README update** — document the new per-country HTML output from coalition runs: `CFP_COUNTRY=all` now writes `tmp/coalition-force-plan.html` (aggregate) + `tmp/cfp-<countryId>.html` per country; `CFP_COUNTRY=<id>` writes a single country file.

### Engine gaps (from Known Gaps table)

5. **Joint demand optimisation per country** — multi-demand countries (Indonesia: SASF+UAV+warheads) are currently optimised independently. The per-demand flip shown in the config table can be misleading when demands share cities.

6. **Optimal city subset search** — currently capital-first ordering; combinatorial city-subset search needed for the true optimum.

7. **`mercenary_outpost` in build planner** — Russia/commando cities need it inserted in the infra chain (same pattern as `secret_weapons_lab`).

8. **Province mobilisation costs** — commando mob cost not yet included in the coalition balance sheet.
