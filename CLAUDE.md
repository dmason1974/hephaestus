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

**Active coalition — PNTH V Iron Aug 2026 (current)**
(`data/scenarios/elite/antarctica/plans/pnth-v-iron-2026-aug.yml`) — supersedes the
PNTH V Road Jun 2026 plan below. Roster picked from real computed economic output
(`npm run smoke:eco-plan`), not population/resource-tier heuristics — see
`data/scenarios/elite/antarctica/coalition-plan.md` for the full ranking and
rationale. 8v8: 6 countries are mainland-forced (hard constraint), 2 chosen on
economics (highest supplies+electronics of the remaining candidates).

| Country | Doctrine | Status | Role |
|---|---|---|---|
| Italy | european | homeland | Mainland-forced — 44 MRL + 1 Tank Veteran + 75 MAAV |
| Japan | western | homeland | Mainland-forced — 34 SASF (pinned to Tokyo/Fujisawa/Sendai, dead-window AWACS sharing — see UAT Round 3 below) + 8 AWACS + 1 Fixed Wing Veteran |
| Russia | eastern | homeland | Mainland-forced — 30 Mobile SAM Launcher + 24 Special Forces + 12 Commando (province) |
| South Africa | european | homeland | Mainland-forced — 44 MRL + 1 Tank Veteran + 75 MAAV |
| Pakistan | western | homeland | Mainland-forced — 44 MRL + 1 Tank Veteran + 75 MAAV |
| India | eastern | homeland | Mainland-forced — 34 SASF (pinned to Mumbai/Kolkata/New Delhi, dead-window warhead/UAV sharing — see UAT Round 3 below) + 1 Fixed Wing Veteran + 15 UAV + 120 Cruise Missiles + 240 Warheads (60 mob slots) |
| Australia | western | homeland | Chosen (economics) — 30 Mechanized Infantry + 70 MAAV + 7 Mobile Radar (keeps its 1 starting-garrison radar instead of suiciding it) |
| New Zealand | european | homeland | Chosen (economics) — 44 MRL + 1 Tank Veteran + 75 MAAV |
| Norway | western | occupied, capture day 4 | Eco only (captured multi-city — ranked 3rd of remaining candidates but taken as a capture, not an active slot) |
| Madagascar | european | occupied, capture day 2 | Eco only (captured AI nation, single city) |
| Solomon Islands | european | occupied, capture day 2 | Eco only (captured AI nation, single city) |
| Mozambique | european | occupied, capture day 2 | Eco only (captured AI nation, single city) |

**Doctrine data gaps affecting this roster (now placeholder-filled)**: Russia's Mobile
SAM Launcher (was `theatre_defense_system` — a hallucinated unit ID, corrected this
session; the real unit was added to `support_units.yml`) and India's Fixed Wing
Veteran (`fixed_wing_veteran` never had `eastern` data at all) were both caught by the
missing-doctrine-data fix (see Unit 3's Known Design Decisions) — surfaced loudly in
`bp-<country>.html`'s "⚠ MISSING DOCTRINE DATA" banner instead of silently dropped.
Both now have **unconfirmed placeholder data** (`western`+`eastern` for Mobile SAM
Launcher, `eastern` for Fixed Wing Veteran — each copied verbatim from `european`,
per the project's existing placeholder convention, e.g. `air_superiority_fighter`'s
eastern baseline) so both demands are back in their country's plan; real screenshot
data for these doctrines is still pending and should replace the placeholders when
available.

**Starting garrison** (every homeland country, all L1, scenario-wide fact in
`scenario.yml`'s `starting_units`): 14 Motorized Infantry, 1 Gunship, 1 Mobile Radar.
Plan decision: disband on day 4 (Australia keeps its radar instead). See "Province
Mobilisation Engine" and "Starting Units" sections below.

Resources are **shared across all coalition countries**.

<details>
<summary>Previous plan — PNTH V Road Jun 2026 (superseded, kept for reference)</summary>

(`data/scenarios/elite/antarctica/plans/pnth_v_road_2026_jun.yml`)

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

</details>

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
    capture_day: 4                # optional, only meaningful when status: occupied; defaults to day 4
    demands:
      - unitId: <unit_id>
        count: <n>
        mobilisation_source: province  # optional — commando and other province-mobilised units
```

**Key design decisions:**
- No `city_roles` field — city assignment is **optimizer output**, not YAML input. All cities are candidates for any role the optimizer needs; none are locked as eco.
- `resource_priority` is coalition-level (not split by queue type). Guides which cities to prefer flipping last (high-priority resource cities lose more eco income when flipped).
- `status` is plan-specific (see Unit 1's "Status + capture day, plan-aware" note above) — a country's occupied-ness is a decision this particular plan made, not an inherent country fact, except for single-city AI nations where it's always true.
- `capture_day` (added this session): per-country override for when an occupied country is actually captured — `eco-plan.ts` reads it when `ECO_PLAN` is set; defaults to day 4 if omitted.
- `mobilisation_source: province` marks units that mobilise from provinces rather than city slots (commando, and any other unit gated on `mercenary_outpost`). These don't compete for city mobilisation capacity, don't require recruiting offices, and use their own capacity model — one slot per province (`src/engine/simulation/province-mobilization-plan.ts`).
- Warheads (`conventional_warhead`) have `batch_size: 4` — each mobilisation slot produces 4 units. They compete for the same city mobilisation slot as all other units. The slot is per-city, not per-building.
- `mercenary_outpost` can **only** be built in a province, never a city (corrected this session — see Post-UAT item 7). It's the reason commando is province-mobilised in the first place: its gating building simply isn't a city option.

### Mobilisation Model

**Every city has one mobilisation slot**, regardless of buildings. Buildings affect:
- **Recruiting office**: speeds up mobilisation (reduces time per unit)
- **Prerequisite buildings** (secret_weapons_lab, army_base etc.): unlock research/mobilisation for specific unit types. `mercenary_outpost` is *not* a city prerequisite — see above; **every province** has its own mobilisation slot too (one per province, country-wide capacity = `provinces.total`), used only by province-mobilised units.

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
| `fixed_wing_veteran` | ⚠ eastern is placeholder | european + western have real data (7 levels); `doctrine` field originally only listed `[european, western]` — eastern was added this session as a verbatim `european` copy (unconfirmed placeholder) purely to unblock India's PNTH V Iron demand (1), which the missing-doctrine-data fix had surfaced as excluded. Needs real eastern screenshots |
| `theatre_defense_system` | ✓ Complete | western + european + eastern; 6 levels; mob/upkeep verified from screenshots; eastern mob/upkeep pending screenshots (unlock days derived: W=5,7,11,13,20,25 / Eu=6,8,12,15,20,28 / Ea=7,10,14,17,20,28) |
| `mobile_sam_launcher` | ⚠ western + eastern are placeholder | Added this session (`support_units.yml`) — corrects a hallucinated `theatre_defense_system` reference in Russia's PNTH V Iron demand. Only `european` research/mobilisation/daily_upkeep data was from real screenshots; `western`/`eastern` added as verbatim `european` copies (unconfirmed placeholders) to unblock Russia's demand (30), which the missing-doctrine-data fix had surfaced as excluded. Needs real western/eastern screenshots |
| `mobile_anti_air_vehicle` | ✓ Flat format | all doctrines (western + european + eastern); 7 levels |
| `multiple_rocket_launcher` | ✓ Complete | european + western + **eastern** (added); 5 levels |
| `mechanized_infantry` | ✓ All doctrines | western + european + eastern; 6 levels; values ported from standard — needs screenshot verification |
| `combat_recon_vehicle` | ✓ All doctrines | western + european + eastern; multi-level; armoured_units |
| `mobile_radar` | ✓ Present | all doctrines; support_units |
| `commando` | ✓ Present | all doctrines; seasonal_units; requires `mercenary_outpost level 1` + `special_forces level 1`; **province-mobilised** (not city slot) |
| `conventional_cruise_missile` | ✓ Present | all doctrines; missile_units; 0 mobilisation cost (launcher platform) |
| `conventional_warhead`, `chemical_warhead`, `nuclear_warhead` | ✓ Present | all doctrines; missile_units; `batch_size: 4` for warhead; uses city mobilisation slot |
| `airborne_infantry`, `special_forces` | ✓ Present | infantry_units |
| `motorized_infantry` | ⚠ Western only | `infantry_units.yml`; old flat format with bare `doctrine: Western` string — european/eastern have no data at all. Used as a Western-values placeholder for all doctrines in starting-garrison upkeep calcs (`scenario.yml`'s `starting_units`) pending real screenshots |
| `tank_veteran` | ✓ Complete | all doctrines; multi-level; armoured_units |
| `gunship` | ⚠ Inline upkeep only, not a catalog unit | Starting-garrison unit (`scenario.yml`'s `starting_units`), never researched/mobilised by the player — deliberately **not** added to `data/scenarios/elite/units/`. L1 daily upkeep confirmed from screenshots: `manpower: 25, fuel: 25, electronics: 25, cash: 80`, identical for eastern/european; western unconfirmed (borrowed from eastern/european, same value) |

---

## Modular Architecture — Three-Unit Rebuild

The coalition force projection engine is being rebuilt as three discrete, independently-runnable units (plus Unit 1.5, added later this session). Each unit has a clean data contract and can be tested in isolation.

```
Unit 1 — Eco Planner                    ✅ COMPLETE
  Input:  scenario, country (resource, population, starting buildings, status)
  Output: EcoPlan — optimal eco build sequence per city, hourly production array
  Question: "What is the best economy this city can achieve over the full truce window?"
  Note: purely theoretical/per-city-isolated — see Unit 1.5 for what actually drives cost/income.

Unit 1.5 — Actual Eco Build             ✅ COMPLETE
  Input:  Unit 1's beam engine + Unit 2's plan-derived resource weights (computePlanWeights)
  Output: force-plan-weighted eco build per city, relocate_headquarters capped to one city
  Question: "Given what the force plan actually needs, what should this city's real economy do?"

Unit 2 — Force Projection               ✅ COMPLETE
  Input:  coalition_force_plan YAML, scenario, buildings + unit data
  Output: per-demand JIT research schedule + minimum-cost mobilisation plan (city count, RO level, timing, cost breakdown)
  Question: "What is the cheapest way to field this force by the deadline?"

Unit 3 — Resource Projection            ✅ COMPLETE
  Input:  Unit 1 eco plans + Unit 2 force plans + coalition starting balances + garrison upkeep
  Output: per-city flip-truncated eco income, coalition balance sheet (pooled resources),
          hourly cash-flow minima, per-country manpower check
  Question: "Given eco income and force costs, when must each city flip, and can the coalition afford it?"
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
ECO_PLAN=pnth-v-iron-2026-aug ECO_COUNTRY=all npm run smoke:eco-plan    # coalition members only (current plan; ECO_COUNTRY=all resolves to Object.keys(plan.countries) — every country in the plan, this is already the default behaviour when a plan is loaded)
ECO_BEAM_WIDTH=50 ECO_TOP_N=3 ECO_COUNTRY=indonesia npm run smoke:eco-plan
```

**Config env vars:** `ECO_SCENARIO` (default: `elite/antarctica`), `ECO_PLAN` (optional — narrows country list to coalition members), `ECO_COUNTRY` (default: `all`), `ECO_BEAM_WIDTH` (default: 50), `ECO_TOP_N` (default: 3).

### Key Design Decisions

- **Unconstrained mode** (`unconstrained: true` in `CityEcoBeamConfig`): no affordability check — each build is scheduled at the earliest free hour. Score = `endBalance[city.resource]` (native resource net of costs). This ensures every city gets a real plan regardless of starting balance.
- **No resource weights**: coalition weights distorted the beam (cash weight=1.0 made AI L4-5 score-negative). Eco planner is purely single-resource — it doesn't know or care about coalition demand.
- **`annex_city` for occupied cities**: candidate pool includes `annex_city` for occupied; excludes it for homeland. All occupied cities always build annex first (production doubles 25%→50%; always ROI-positive over the ~600h window).
- **`recruiting_office` always in pool**: for all cities. L1 RO is 30 min and gives manpower bonus from that hour.
- **Status + capture day, plan-aware (updated)**: when `ECO_PLAN` is set, `status` and `capture_day` resolve from `plan.countries[countryId]` first, falling back to `country.country.status` (country YAML) then `"homeland"`, and `capture_day` falling back to day 4. Without a plan, behaviour is unchanged (country YAML only, plan-independent). This matters because **status is plan-specific, not a country-intrinsic fact**, for any 7-city country — a country like Norway can be homeland in one coalition's plan and a capture in another's. The *only* country YAML that should carry a hardcoded `status: occupied` is a single-city AI nation, where occupied is the only state it can ever be in (it can never be actively "homeland"-played). `united_kingdom.yml`'s `status: occupied` was removed this session for exactly this reason — it's a 7-city country, so its occupied-ness belongs in the plan, not the country file. See `coalition-force-plan-schema.ts`'s `countryPlanSchema.capture_day` (optional, defaults to day 4 when occupied).
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

Single-city AI nations with `status: occupied` hardcoded in their country YAML (correct — inherently capture-only, see above): `iran`, `madagascar`, `solomon_islands`, `mozambique`. `united_kingdom` and `norway` (both 7-city) do **not** carry `status` in their country YAML — their occupied-ness is plan-specific and lives in whichever `coalition_force_plan` YAML currently captures them.

---

## Unit 1.5 — Actual Eco Build ✅ COMPLETE

### Why This Exists

UAT of the PNTH V Iron plan found that Unit 1's theoretical beam output was being fed
directly into Unit 3's cost/income accounting as if it were the real plan, causing
concrete, quantified distortions: `relocate_headquarters` (a per-country, at-most-once
decision — moving the one HQ) was independently built in 6 of Italy's 7 cities (90,000
cash + 15,000 manpower of phantom cost, since each city's isolated beam finds it
ROI-positive with no cross-city exclusivity); `arms_industry`/`air_base`/`naval_base`
were pushed to max level in every city regardless of true cross-resource cost (Palermo,
a fuel city, spent 600 electronics — the coalition's flagged shortfall resource — for a
marginal fuel-only gain going AI2→AI5, because the beam's unweighted scoring treats
resources a city doesn't produce as free); Unit 2's infra chain double-built buildings
the eco phase had already built (Rome's arms_industry L1, built once on day 1 in eco,
rebuilt again on day 11-12 in the force plan); and RO L1 was never built during the eco
phase at all (manpower isn't a native resource so it never clears the beam's
positive-return threshold) and wasn't prioritised first in Unit 2's chain either.

User's direction: Unit 1's beam stays exactly as-is — still a legitimate theoretical
per-city ceiling, still what `smoke:eco-plan` shows. A new, separate "actual eco build"
layer, driven by Unit 2's real resource footprint, needed to be built and become what
Unit 3 actually consumes for cost/income accounting.

### What Was Built

`src/engine/eco/actual-eco-build.ts` — `runActualEcoBuild` reruns Unit 1's beam engine
(`runCityEcoBeam`) per country with `resourceWeights` sourced from
`computePlanWeights` (`joint-city-optimizer.ts` — already existed, already correctly
derived from the plan's mob+upkeep resource footprint, just never wired to the eco
beam before this). `selectHeadquartersCity` picks at most one city to be allowed to
build `relocate_headquarters`: it respects a scenario-level manual override
(`resolveScenarioHeadquartersCity`, `headquarters_city_by_country` in `scenario.yml`,
currently unset for every country) first; otherwise it trial-reruns each non-capital
homeland city's beam scoped to just that city (cheap — `runCityEcoBeam`'s `cityFilter`
+ a fixed country-baseline table computed once) and picks the largest **positive**
`computeWeightedScore` delta vs. not relocating at all, or `undefined` if none is
positive.

Runs **before** Unit 2 — verified safe, no circularity: `computePlanWeights` only needs
the demand list (unit + count), not Unit 2's city assignment (`foldInDemands`), so
weights (and therefore Unit 1.5) can be computed first.

```
demands ──► computePlanWeights ──► runActualEcoBuild (Unit 1.5) ──┐
                                                                    ├──► computeCountryForceProjection (Unit 2)
                                                                    │        (eco-credited flip points + infra chains)
                                                                    └──► computeCountryResourceBalance (Unit 3)
                                                                             (actual income/cost, not theoretical)
```

**Engine changes to support this:**
- `city-eco-beam.ts` — `CityEcoBeamConfig` gained `hqCityId?: string`;
  `buildingPoolForCity` only adds `relocate_headquarters` to a city's candidate pool
  when `city.id === hqCityId` (absent ⇒ no city ever considers it — a structural cap,
  not a weight threshold, since a weight alone can't stop multiple cities each
  independently finding it ROI-positive). Exported `computeWeightedScore` so
  orchestration code scores consistently with what the beam itself optimises for. RO
  L1 is forced as the beam's search root (not left to scoring) whenever
  `resourceWeights` is supplied — i.e. only in Unit 1.5's run, never Unit 1's
  unconstrained theoretical run, which is completely untouched by any of this.
- `flip-point-solver.ts` — `computeFlipPoint`/`buildRemainingChain` gained an optional
  `orderBuildings?: (ids: string[]) => string[]` callback (default preserves the
  existing `CHAIN_ORDER` behaviour for `coalition-force-plan.ts`, the only other
  caller).
- `country-force-projection.ts` — exported `classifyDemands`/`getBatchSize`.
  `buildCityInfraSteps` (the formula-based, from-scratch chain builder) now puts RO
  first unconditionally instead of ecoScore-sorting it against everything else. New
  `buildCityInfraStepsFromEco` reuses `computeFlipPoint`'s convergence loop (with
  `deadlineAbsHour := firstMobStart`, `mobilisationWindowHours := 0` — repurposing the
  same `flip = deadline − window − remainingBuildHours` formula) to both skip building
  levels the eco phase already completed **and** iteratively re-derive the flip point
  later when eco got a head start, capturing more eco income. `CountryForceProjectionInput`
  gained optional `planWeights?`/`actualEcoResultsByCity?` (bare-cityId-keyed map of
  Unit 1.5 results) — both default to the old from-scratch behaviour when absent, so
  every existing caller (`force-projection.ts`, existing tests) needed zero changes.
- `resource-projection.ts` — `analyseCountry` now computes `planWeights` via
  `classifyDemands` + `computePlanWeights`, calls `runActualEcoBuild` instead of the
  raw unconstrained `runCityEcoBeam`, and feeds the result into both
  `computeCountryForceProjection` (for eco-credited flip points/infra) and
  `computeCountryResourceBalance` (for actual income/cost — this is the switch that
  fixes the phantom-cost problems above). Unit 1's unconstrained beam is no longer
  called by this harness at all; `smoke:eco-plan` remains the only place to see it.

### Verified Against the Real Plan (Italy)

- `relocate_headquarters`: 6 cities → 0 (no city found it worthwhile under real plan
  weights; the plan's demand footprint doesn't justify the manpower cost).
- Palermo (fuel, lowest-weighted resource in the MRL/MAAV/Tank-Veteran plan):
  arms_industry L5 → L3.
- Rome's force-projection infra chain no longer rebuilds arms_industry L1 (credited
  from the eco phase — it's already complete by the flip point).
- RO L1 is first in every city's eco sequence (hour 0) and every force-projection
  infra chain.

### Deliberately Deferred

`foldInDemands` (Unit 2's city/RO-level assignment) stays formula-based/eco-unaware —
making it eco-aware would need a real fixed-point iteration (assign → weights → eco
build → re-time → re-assign → …); this phase only makes the **post-assignment**
timing (flip points, infra chains) eco-aware. Flagged as a future chunk if the
assignment itself needs to reflect real eco state, not just its timing.

---

## Unit 2 — Force Projection ✅ COMPLETE

**⚠ `force-projection.ts` / `fp-<countryId>.html` deprecated** — superseded by Unit 3's
`bp-<countryId>.html` (see Unit 3 section below), whose Research + combined
Infrastructure Build sections cover the same ground and do it better (eco-credited via
Unit 1.5, which this Unit-2-only harness never is). Kept as a standalone Unit 2 view,
not actively maintained; prints a deprecation warning when run.

### What Was Built

`src/harness/smoke/force-projection.ts` — standalone force harness, `npm run smoke:force-projection`.
`src/engine/optimization/joint-city-optimizer.ts` — fold-in city optimizer engine.

Writes `tmp/fp-<countryId>.html` per country. Sections per military country:
1. **Research Plan** — combined JIT research schedule across both slots for all demands (L1 ASAP per unit)
2. **City Mob Build Plans** — one section per city: data-driven eco-score build sequence → mob queue (Smith's rule ordering); each city section now leads with a labeled **"Flip point: day X"** line (see Post-UAT item 9) — the latest hour that city can still run eco builds before switching to military infra
3. **Mobilisation Cost Summary** — aggregate infra + mob + stepped-upkeep, **plus province mob + mercenary_outpost cost and province upkeep** (Post-UAT item 8) across all demands
4. **Province Mobilisation Detail** — one line per province-mobilised demand (e.g. commando): mercenary_outpost level/build hours, mobilisation hours, completion hour, province capacity used

**Run syntax:**
```
FP_PLAN=pnth-v-iron-2026-aug FP_COUNTRY=russia npm run smoke:force-projection   # current plan, single country
FP_COUNTRY=all npm run smoke:force-projection         # all plan countries (code default plan is still pnth_v_road_2026_jun — pass FP_PLAN explicitly for the current plan)
FP_MAX_RO=3 FP_COUNTRY=indonesia npm run smoke:force-projection
```

**Config env vars:** `FP_SCENARIO` (default: `elite/antarctica`), `FP_PLAN` (code default: `pnth_v_road_2026_jun` — pass `FP_PLAN=pnth-v-iron-2026-aug` for the current plan), `FP_COUNTRY` (default: `all`), `FP_MAX_RO` (default: 5).

### Key Design Decisions

- **Fold-in city optimizer** (`joint-city-optimizer.ts`): demands sorted by infra heaviness (heaviest picks first). Each demand tries absorption into existing compatible cities before opening new ones. Comparison is plan-weight-scaled total cost (infra + mob + triangular upkeep).
- **Smith's rule mob ordering**: within a city, units sorted ascending by `upkeepRate / T_per_unit`. Near-zero-upkeep units (warheads) mob first; expensive units (SASF) mob last → JIT for high-cost units.
- **Plan-derived weights**: `computePlanWeights` sums mob + upkeep footprint per resource across all demands; most-consumed resource = 1.0. No hardcoded weights.
- **Data-driven build ordering**: pre-mob infra buildings sorted by `ecoScore` derived from building YAML `production_bonus_pct` and `manpower_bonus_pct` (weighted by plan weights). No hardcoded building names or ordering.
- **Morale curve**: `MoraleAtHour` type threads through all mob-duration calculations; homeland curve 70%→93% (day 1→21+). One-pass iteration resolves circular dependency (JIT mob start depends on T, T depends on morale at mob start).
- **Stepped upkeep**: `computeSteppedUpkeep` integrates over intervals defined by both mob-completion events and JIT research level-completion events. Units auto-upgrade as research completes; upkeep steps up accordingly.
- **Province demands** (`mobilisation_source: province`) excluded from city slot — commando doesn't compete for city capacity. **Now actually costed** (Post-UAT item 8) via `src/engine/simulation/province-mobilization-plan.ts` — capacity = one slot per province (country's `provinces.total`), not skipped/dropped as before.
- **Batch units** (`batch_size: 4` for warheads) — 100 warheads = 25 mob events; total alive = count × batchSize.
- **Launcher platforms** (cruise_missile, mob time = 0) — skipped.
- **Flip point** (Post-UAT item 9): each city's infra start time was always correctly JIT-derived (`Math.max(infraOpenHour, deadlineAbsHour − T)` already picks the right latest-feasible value), just never labeled as meaningful. Now surfaced explicitly per city as "Flip point: day X" in the HTML output, plus a formal `CityMobSlot.flipPointHour` field.

### Engine Changes

- `research-schedule-optimizer.ts` — `latestL1EndHour` parameter for JIT L1 scheduling (L1 ends at deadline − mob window).
- `unit-research-sim.ts` — simplified impact score: `mob + 24×upkeep` per unit (absolute, not delta vs previous level).
- `cost-calculator.ts` — `calculateTriangularUpkeepForConfig` added: proper triangular upkeep accounting where each unit pays from when it completes mobilisation to deadline.

### Country YAML — `provinces` Block

Countries with provinces now carry a `provinces` block listing total province count and how many produce each resource:

```yaml
provinces:
  total: 33
  supplies: 1
  components: 1
  fuel: 1
  rares: 1
  electronics: 0
```

(Real Russia values, derived this session from in-game VP data — see "Province Data" below. The `total` includes non-resource-producing provinces too; the remainder after summing the five resource fields becomes a `non_resource_provinces` cohort, per `src/engine/provinces/province-cohorts.ts`.)

`src/engine/eco/province-eco-beam.ts` computes province eco builds per resource cohort and is called from the eco-plan harness (`npm run smoke:eco-plan`) to show province build plans alongside city plans.

### Province Data — VP-to-Province Formula

Province totals for the 14 PNTH countries (now correct in every `elite/antarctica` country YAML; previously 9 had none and the other 5 shared an identical, wrong placeholder) were derived from in-game nation-list screenshots (Nation/Cities/VP columns), using a formula confirmed against 5 independent examples with zero deviation:
- **7-city countries**: `total_provinces = VP − 34`
- **1-city ("small AI") countries**: `total_provinces = VP − 4`

Reusable for any other `elite/antarctica` country not yet filled in. Per-resource breakdowns are specific to a given playthrough (resource-tile assignment is randomised per game) — 9 of the 14 PNTH countries have a real user-supplied breakdown; Indonesia, United Kingdom, Iran, Madagascar, Solomon Islands still have an all-zero placeholder split pending that data (their `total` is correct either way).

### Starting Units — Garrison Mechanic

Every **homeland** country starts with a fixed garrison, recorded scenario-wide in
`data/scenarios/elite/antarctica/scenario.yml`'s `starting_units` field
(`src/schemas/scenario-schema.ts`, `resolveScenarioStartingUnits`):

```yaml
starting_units:
  - unit_id: motorized_infantry
    count: 14
    level: 1
  - unit_id: gunship   # not in the unit catalog — inline upkeep only, see below
    count: 1
    level: 1
    daily_upkeep:
      eastern:  { manpower: 25, fuel: 25, electronics: 25, cash: 80 }
      european: { manpower: 25, fuel: 25, electronics: 25, cash: 80 }
      western:  { manpower: 25, fuel: 25, electronics: 25, cash: 80 }  # unconfirmed, borrowed
  - unit_id: mobile_radar
    count: 1
    level: 1
```

Each entry resolves cost/upkeep from the unit catalog by `unit_id` + `level`, **except**
when an inline `daily_upkeep` is present (gunship) — that overrides the catalog lookup,
since gunship isn't (and per the user, doesn't need to be) a full catalog entry with
research/mobilisation data; it's never actually researched or mobilised by the player.

**PNTH V Iron plan decision**: all garrison units disband on day 4, except Australia
keeps its starting Mobile Radar (folds into its 8-radar target, so only 7 need
mobilising instead of 8). Combined daily upkeep per homeland country before the day-4
disband: supplies 580, fuel 250, electronics 25, cash 960, manpower 250 (see
`coalition-plan.md` for the full breakdown table). **Now wired into Unit 3** (see
below) via `computeGarrisonUpkeep` — though Australia's radar-retention exception is
not modeled there yet (uniform disband for all homeland countries, a deliberate small
simplification — see Unit 3's Known Limitations).

---

## Unit 3 — Resource Projection ✅ COMPLETE

### What Was Built

`src/harness/smoke/resource-projection.ts` — standalone harness, `npm run smoke:resource-projection`. Combines Unit 1 (eco income) and Unit 2 (force costs) into one real coalition balance sheet.

New engine modules:
- `src/engine/eco/city-eco-income.ts` — `cityIncomeThroughFlip` / `cityFullEcoIncome` + resource-map helpers (`zeroResourceMap`, `addResourcesInto`, `scaleResources`), extracted from `coalition-force-plan.ts`'s private helpers of the same shape (byte-identical HTML output verified before/after) so Unit 3 doesn't duplicate the income-truncation logic.
- `src/engine/optimization/country-force-projection.ts` — `computeCountryForceProjection`: a structured (non-HTML) extraction of `force-projection.ts`'s `analyseCountry` computation, verified byte-identical across every country in both `pnth_v_road_2026_jun` and `pnth-v-iron-2026-aug` before/after the refactor. Exposes per-city `flipPointAbsHour` (the real, research-aware flip point — previously only a local variable, `jitInfraStart`), `infraSteps` (now carrying a per-step `cost: ResourceCost`, added for Unit 3's hourly walk), `mobSteps`, and aggregate cost buckets.
- `src/engine/optimization/garrison-upkeep.ts` — `computeGarrisonUpkeep`: the first caller of `resolveScenarioStartingUnits` (previously dead code, zero call sites anywhere). Resolves daily upkeep per starting unit via `calculateDailyUpkeep`, falling back to whichever doctrine the catalog does have data for when the requested one is missing (`motorized_infantry` is Western-only pending screenshots — see "Elite Unit Catalog Status" — so this fallback is what makes garrison upkeep computable for eastern/european countries at all). Units with an inline `daily_upkeep` (gunship) use that instead, same fallback rule.
- `src/engine/reporting/coalition-resource-balance.ts` — `computeCountryResourceBalance` + `computeCoalitionResourceBalance`: combines flip-truncated eco income + starting balance − eco build cost − force costs − garrison upkeep into a per-country and coalition-level balance sheet (`POOLED_RESOURCES` only; manpower checked per-country via `PER_COUNTRY_RESOURCES`), plus an hourly cash-flow walk that finds the lowest running pooled balance at any hour in the window (`resourceMinima`) — catches mid-window insolvency the end-of-window totals alone would miss.

Writes `tmp/resource-projection.html` (coalition aggregate) + `tmp/bp-<countryId>.html` per country (the "build plan" — the only per-country output; the earlier `rp-<countryId>.html` balance-only file was retired since its entire content duplicated `bp-*.html`'s section 1).

`bp-<countryId>.html` has 4 sections, in order:
1. **Resource Balance** — same balance sheet as the coalition aggregate's per-country rows.
2. **Research** — combined JIT research schedule (`forceProjection.researchSegments`).
3. **Infrastructure Build (eco + military, combined per city)** — one merged, chronological timeline per city: eco-phase steps (credited up to the flip point — filtered against `buildingLevelsAtAbsHour`, same logic `buildCityInfraStepsFromEco` itself uses to skip pre-built levels), a `→ FLIP` marker, then the military infra chain and mob queue. City headers show `★` for the current HQ (capital by default, or wherever `relocate_headquarters` actually got built) and the city's resource type in brackets; cities are listed alphabetically.
4. **Force Projection** — cost summary (infra/mob/upkeep/province breakdown), province mobilisation detail, skipped demands.

The eco data behind sections 1 and 3 comes from Unit 1.5 (`runActualEcoBuild`, `src/engine/eco/actual-eco-build.ts`) — a force-plan-weighted rerun of Unit 1's beam, not Unit 1's own unconstrained/theoretical output (`smoke:eco-plan` remains the only place to see that ceiling).

**Run syntax:**
```
RP_PLAN=pnth-v-iron-2026-aug RP_COUNTRY=all npm run smoke:resource-projection      # RP_PLAN is required — errors if unset
RP_PLAN=pnth-v-iron-2026-aug RP_COUNTRY=russia npm run smoke:resource-projection   # single country
```

**Config env vars:** `RP_SCENARIO` (default `elite/antarctica`), `RP_PLAN` (**required, no default** — see below), `RP_COUNTRY` (default `all`), `RP_MAX_RO` (default 5), `RP_BEAM_WIDTH` (default 50), `RP_TOP_N` (default 3), `RP_GARRISON_DISBAND_DAY` (default 4), `RP_OUTPUT_FILE` (default `tmp/resource-projection.html`).

### Key Design Decisions

- **Join-key gotcha (the one real trap in this design)**: Unit 1's `CityEcoResult.cityId` is prefixed (`${countryId}:${cityId}`); Unit 2's `CityForceProjectionSlot.cityId` is bare. `coalition-resource-balance.ts` normalizes this explicitly (`bareCityId()`) when matching a city's eco result to its flip point — get this wrong and every city silently falls back to untruncated (full 28-day) income.
- **`RP_PLAN` has no default** — deliberately, unlike `FP_PLAN`'s stale default (`pnth_v_road_2026_jun`). This is the harness that produces the real combined balance sheet, so silently running the wrong plan is worse here than a required-env-var error.
- **`capture_day` now genuinely per-country** in this pipeline: `resource-projection.ts` reads `countryPlan?.capture_day ?? 4` (the `eco-plan.ts` pattern), not the hardcoded day-4 the older `coalition-force-plan.ts` uses.
- **Hourly cash-flow minima is an approximation, not a reconciliation**: income is capped precisely at the flip point; infra costs are deducted at each infra step's completion hour (exact, reusing the same `calculateBuildingCost` totals as the top-level cost aggregate); mob costs are deducted at batch start (exact); but upkeep in the hourly walk uses a **continuous L1 rate** rather than the exact stepped (auto-upgrade-aware) rate the totals table uses (`costs.upkeep`, via `computeSteppedUpkeep`). The two won't bit-match at the final hour — this is called out directly in the rendered HTML. Good enough to answer "does the pool ever go negative mid-window", not a substitute for the totals row.
- **Australia's radar exception is not modeled** — `computeGarrisonUpkeep` disbands the full starting garrison uniformly for every homeland country (default day 4, `RP_GARRISON_DISBAND_DAY`). The documented PNTH V Iron exception (Australia keeps 1 mobile radar) is a deliberate v1 simplification — small dollar impact (~480 supplies / ~360 fuel / ~360 manpower / ~960 cash total over the window for one unit).
- **HTML rendering duplicated inline**, not extracted to a shared module — matches the existing convention across all `harness/smoke/*.ts` scripts (each owns its own `escapeHtml`/`htmlTable`/balance-sheet formatting helpers; there is no shared-lib precedent in that directory).
- **Missing-doctrine-data bug, fixed this session**: `unitMobTimeHours` (`country-force-projection.ts`) returned `0` for a unit with genuinely zero mob time (a real launcher platform) *and* for a unit with no mobilisation data at all for the country's doctrine — `classifyDemands` couldn't tell the two apart, so a demand with a doctrine data gap was silently misclassified as a launcher platform and dropped from the plan entirely, with zero warning (found via Russia's `mobile_sam_launcher`, added this session with only `european` data, while Russia's doctrine is `eastern`). Fixed: `hasMobilisationData` checks presence explicitly; `classifyDemands` now routes data-gap demands to a new `missingDataDemands` bucket, kept separate from `launcherDemands` (genuine zero-cost launchers, e.g. `conventional_cruise_missile`) and excluded from `activeDemands` (so `computePlanWeights` never throws on it). Surfaced loudly in `bp-<countryId>.html` (a `⚠ MISSING DOCTRINE DATA` banner at the top, not the quiet grey "Skipped Demands" list) instead of silently. See `country-force-projection.test.ts`'s two `classifyDemands` regression tests.

### Known Limitations

- Hourly-minima walk's upkeep approximation (see above) means it's a shortfall detector, not a bit-exact reconciliation of the totals balance sheet.
- Australia's radar-retention exception not modeled (uniform garrison disband for all homeland countries).
- No optimal city-subset search — inherited from Unit 2's fold-in (capital-first-ish) city ordering; still a future chunk.
- **Doctrine data gaps, now placeholder-filled**: Russia's `mobile_sam_launcher` and India's `fixed_wing_veteran` both lacked `eastern` doctrine data (surfaced by the fix above); both now have unconfirmed `european`-copy placeholder data — see the PNTH coalition table's data-gap note. Real screenshot data still pending.

---

## UAT Round 3 — Idle-Window Backfill, Coalition-Wide Eco Weights, Dead-Window City Sharing ✅ COMPLETE

Three related fixes, all discovered via UAT of `resource-projection.ts`'s output on `pnth-v-iron-2026-aug`, each iterated through multiple design attempts before landing on the version below — earlier attempts are kept out of this doc since they were superseded, not shipped.

### Bug 1 — Idle infra-queue backfill

**Problem**: Unit 1.5's eco beam stops adding buildings once nothing scores positively under plan weights, leaving a city's build queue genuinely idle for however long remains until the (independently computed) flip point — e.g. Naples sat idle ~240h, Bari ~11 days, before their own flip points. Guaranteed post-flip buildings (RO to target level, arms_industry, army_base — whatever `requiredLevelsForUnit` already knows the city needs) were never pulled into that idle window even though doing so has zero downside (a city's base production doesn't depend on what's in its build queue).

**Fix**: `src/engine/eco/flip-point-solver.ts`'s `computeEcoBackfill`/`withBackfilledLevels` — greedily fills the idle window (from `CityEcoResult.lastEcoBuildCompletionAbsHour`, previously computed but never consumed) with guaranteed required levels, ordered by the same `orderBuildings` convention as the post-flip chain; stops at the first level that doesn't fit (no skip-ahead/bin-packing, matching every other sequential-queue builder in this codebase). `country-force-projection.ts`'s `buildCityInfraStepsFromEco` wraps `computeFlipPoint` in a small convergence loop (≤3 iterations: backfill → re-derive flip → repeat) since backfilling can only shrink the remaining chain, so the flip point only ever moves later or stays put — provably convergent. `CityForceProjectionSlot.ecoBackfillSteps` carries these steps, structurally disjoint from `infraSteps` (once a level is backfilled, `buildRemainingChain` can no longer emit it — no separate de-dup pass, "eco planner slot always wins" falls out of feeding the same augmented current-levels state into the same unmodified chain-builder). Rendered as `[eco-backfill]` rows in `bp-<countryId>.html`, before `→ FLIP`. Also re-simulates each backfilled city's `hourlyCityProduction` (`city-eco-beam.ts`'s `resimulateHourlyProductionWithExtraActions`) so the balance sheet credits the backfilled buildings' real bonus (e.g. RO's manpower bonus) at their real, earlier completion hour — not just the rendered timeline.

### Bug 2 — Coalition-wide eco weights (final design, after two abandoned attempts)

**Problem**: Palermo (Italy, fuel-tile) built `arms_industry` to L3 despite the coalition sitting on a 41k fuel surplus — Unit 1.5's beam has no visibility into what the rest of the coalition produces, only that country's own narrow plan weights.

**Abandoned attempt 1 — pre-hoc weight damping**: computed a coalition-wide supply/demand estimate and damped each country's `resourceWeights` before the beam ran. Fixed Palermo, but broke real cities that legitimately needed heavy investment for a genuinely-short coalition resource (Messina/electronics stuck at AI L3, New Delhi/electronics similarly capped, Sendai/Japan's air_base under-built) — a single coalition-wide multiplier can't distinguish "this city's investment is wasteful" from "this resource is handled elsewhere." **Abandoned attempt 2 — post-hoc right-fit trim**: let the beam run undamped, then surgically trim the single most marginal discretionary building action from cities whose native resource showed a real coalition-wide surplus. Correct in principle but replaced by a simpler root-cause fix once identified (below); the trim module (`eco-right-fit.ts`) was deleted.

**Shipped design**: `computeCoalitionPlanWeights` (`joint-city-optimizer.ts`) — every homeland country's eco beam is weighted by the **aggregate demand across the whole coalition** (Σ mob + avg-upkeep cost summed across every homeland country's own demands, normalised once), not that country's own narrow demand list. Root cause this fixes directly: Italy's own demands (MRL/MAAV/Tank Veteran) barely touch electronics (its own weight ≈ 0.117), so Messina's beam had no reason to invest further — even though India/Japan's SASF/UAV-heavy demands make electronics one of the coalition's most valuable pooled resources. Feeding every country's beam the coalition-wide weight instead fixes this with **zero pre-distortion of the beam's own scoring** — it only changes which weights are handed to it. `computeCountryForceProjection`'s fold-in (`foldInDemands`) keeps using each country's own `computePlanWeights` unchanged (a genuinely country-scoped decision — RO level/city assignment cost comparisons).

Coalition-wide weights alone weren't quite strong enough (material resources are structurally capped below cash's dominant weight in the mob+upkeep-cost-derived formula) — `resource-projection.ts` runs a **two-round pass**: round 1 computes every country with the base coalition-wide weights and checks the resulting real coalition balance for genuine deficits; round 2 (`boostWeightsFromDeficit`, boost-only — never reduces a weight, so it can't cause the round-1-attempt-1 collateral damage) raises weight toward 1.0 proportional to deficit severity for resources still short, and re-runs *only* the cities producing those resources (`runCityEcoBeam` with `cityFilter`, preserving round 1's `hqCityId` decision). Confirmed empirically: Messina/Sendai AI L3→L4, electronics weight 0.151→0.468, electronics coalition deficit −148k→−132k, Palermo (not in deficit) correctly untouched. **Known limitation**: a single boost round narrows but doesn't fully close every deficit (supplies/electronics/cash all still negative after round 2) — a second boost round would likely narrow further at the cost of another full beam-search pass; not implemented, flagged for a future round if needed. Single-country runs (`RP_COUNTRY=<id>`) still load every plan country's demand list to compute the coalition-wide weight (cheap, no beam search), so they remain fast and correctly coalition-aware even in isolation.

### SASF dead-window city sharing (India + Japan)

**Problem**: `stealth_air_superiority_fighter`'s prerequisite chain (`air_base L5` + `secret_weapons_lab L1` + `air_superiority_fighter L4` research) takes ~150+ hours to build. Fielded from a single city per country, that city's *mobilisation* queue sat completely idle the whole time — nothing else was assigned to it.

**Fix, three parts, all scoped/opt-in (not global defaults) per this session's decision**:

1. **City pinning** — `coalition-force-plan-schema.ts`'s `demandSchema` gained `preferred_cities?: string[]` (optional). `foldInDemands` (`joint-city-optimizer.ts`) pre-processes demands carrying it in a pass before the normal cost-driven fold-in: opens exactly those named cities, splitting `effectiveCount` evenly (`estimateRoLevelForFixedCityCount`, a fixed-city-count variant of `estimateBestNewCityConfig`'s RO sweep), then removes them from the pool so the normal cost-driven overflow path never re-opens them for something else. Demands without the field are completely unaffected (same cost-driven path as always). India's SASF (34, down from 39) pins to `[mumbai, kolkata, new_delhi]` (2 supply-tile + the electronics capital); Japan's SASF (34, down from 39) pins to `[tokyo, fujisawa, sendai]` (same shape — 2 supply-tile + the electronics-tile city). **Why these specific cities, not arbitrary**: `arms_industry`/`air_base` carry a real `production_bonus_pct` that also boosts the city's own eco output, so an air-role demand assigned to a resource-tile city is simultaneously a real eco investment — supplies and electronics are the two highest-weighted non-cash resources under the coalition-wide weights above, so this pick is the same resource-priority signal the engine already computes, not a heuristic guess. The **existing** absorption logic (`infraCompatible`, unmodified) already treats a filler demand whose requirements are a subset of the pinned city's primary demand (warhead/uav/awacs vs. SASF) as a valid absorption candidate — confirmed empirically to work immediately once the pinned cities were opened, no new code needed for the city-assignment side of cross-queue sharing.

2. **Per-demand mob-queue readiness** — the real gap CLAUDE.md had flagged conceptually but never implemented. `applyAbsorption` gave every demand sharing a city the *same* `infraOpenHour` (the full primary unit's chain completion), so a filler couldn't become mobilisation-eligible earlier just because its own narrower requirements finished sooner (`conventional_warhead` needs only `secret_weapons_lab L1` + `arms_industry L1` — no `air_base` at all; `uav` needs `air_base L1` + `arms_industry L1`; `awacs` needs `air_base L4` + `arms_industry L1`). `country-force-projection.ts`'s `computeReadinessHour` computes each filler's own readiness from the city's actual `ecoBackfillSteps`/`infraSteps` timeline (max completion hour across only that unit's own required levels — a level not found there falls back to `flipPointAbsHour`, a safe conservative upper bound). `scheduleDeadWindowMobQueue` replaces the fixed Smith's-rule-sorted walk (used for every other slot) with a **time-aware greedy scheduler**: fillers are mobilised as soon as they're eligible, lowest-Smith's-ratio-first among what's currently eligible (re-evaluated at each step, not decided once upfront) — this matters because a fixed sort-then-walk would either waste the early window entirely (if the lowest-ratio-but-latest-eligible filler were processed first in sorted order) or lock in whichever filler started first regardless of a cheaper one becoming eligible later. Concretely: `uav` (ratio > 0, eligible early) fills the genuinely-idle window before `warhead` (ratio = 0, `daily_upkeep` is a literal empty cost object) becomes eligible, then `warhead` is preferred for the queue's remaining capacity once it comes online. The primary unit (SASF) is still scheduled last, JIT-delayed exactly as before — inserting fillers into genuinely idle time ahead of it doesn't push its own timeline later unless the fillers' total duration exceeds the dead window. A separate, earlier research-scheduling pre-pass (`latestCompletionByUnitLevel`, built before the per-city loop) needed its own fix: it originally used the same stale `infraOpenHour + cumBefore` formula to set each filler's L1-research JIT deadline, which (confirmed empirically) forced warhead's research to complete around hour 247 instead of ~53, silently defeating the whole mechanic even after the mob-queue scheduler itself was fixed. Fixed with `sumRequiredBuildHoursFromScratch` — an early, safe, primary-unit-independent estimate (sum of the filler's own required levels' build times from scratch, ignoring the primary's chain and any eco credit) — deliberately *not* `slot.flipPointHour` (tried first; that's the *primary* unit's own latest-safe-flip point, which can itself be late when the primary has plenty of slack, and made the constraint worse, not better, in testing).

3. **Dead-window build order** — `country-force-projection.ts`'s `isDeadWindowSlot` (a slot qualifies when its `mobQueue` pairs a long-pole unit with ≥1 filler whose requirements are a strict subset — computed once city assignment is known, before the infra chain is built) gates a new `makeDeadWindowOrderBuildings`, used **only** for qualifying slots (every other slot keeps `makeInfraOrderBuildings` exactly as before — **scoped, not a global replacement, per this session's explicit decision**; reconsidering a global default is flagged as future work below). Moves `secret_weapons_lab` to the front of the ordering (it has no `production_bonus_pct`, so it always sorted last under the default `ecoScore` rule) instead of dead last — this is what unlocks warhead-eligibility as early as possible. Moves `recruiting_office` to the end instead of the front. This does **not** delay RO's day-1 manpower benefit in practice: RO L1 is already forced as the very first *eco-phase* action (`forceRO` in `city-eco-beam.ts`), entirely upstream of this ordering function (which only governs the post-flip *remaining* chain) — so by the time this runs, RO is normally already credited to L1, and "RO last" here almost always only defers L2+. **Known, accepted limitation**: the formula-based fallback path (`buildCityInfraSteps`, used only when a city has no Unit 1.5 eco result) has no eco-phase RO credit, so in that fallback specifically RO L1 would also be deferred to the end — accepted since the real harness always supplies eco results, so this fallback is essentially unused in practice. Also considered and rejected: true level-by-level interleaving of `arms_industry`/`air_base` (the "AI and air base mixed as per beam" framing) — `arms_industry`'s `production_bonus_pct` is exactly double `air_base`'s at every level (0.1×level vs. 0.05×level in `buildings.yml`), so a per-level score comparison would never actually alternate; it would just build arms_industry fully first, identical to the existing (non-interleaved) `ecoScore` ordering. Genuine interleaving would require replicating the eco beam's own richer, multi-resource-weighted evaluation for this sub-problem — not done, flagged as future work if it turns out to matter empirically.

### Post-shipping hardening (found during final verification, same session)

Three further bugs surfaced only once real harness output was checked against the user's own predictions ("there is a 9 day deadzone between ro3 and sasf starting", "awacs can be built across the three sasf cities before ai5 completes"/"only 8 are required and that is 2.66 per city..."). All three are fixed and verified in the real (eco-credited) production pipeline via `bp-india.html`/`bp-japan.html`, not just the direct-API debug scripts used while iterating.

4. **`firstMobStart` correctness fix** — user caught a genuine ~9-day dead zone between RO3 completing and SASF mobilisation starting in New Delhi. Root cause: dead-window slots were still using the *whole-queue combined-total* formula (`deadlineAbsHour − slot.usedHours`, i.e. every unit in the queue's total mob time summed) to derive the latest-feasible infra start, when only the *primary* unit's (SASF's) own mob duration should bound that JIT calculation — the fillers' mob time doesn't belong in the same subtraction since they run in genuinely idle capacity, not on the critical path. Fixed: for `deadWindow` slots, `firstMobStart = Math.max(slot.infraOpenHour, deadlineAbsHour − primaryTotalHours, primaryL1End)` (primary unit's own total mob hours and own L1 research-completion hour only); non-dead-window slots keep the original whole-queue formula unchanged.

5. **Bounded `arms_industry` boost** — with `firstMobStart` fixed, some cities still have real idle capacity between when their required infra finishes and when `firstMobStart` allows mobilisation to begin (this is exactly what the user flagged as "AI3/4/5 fits in the gap" for New Delhi/Mumbai/Kolkata, generalised to Sendai/Tokyo/Fujisawa too). A two-pass approach: build the baseline chain first, measure the *real* remaining idle capacity (`firstMobStart − chain.infraDoneHour`), then greedily boost `arms_industry` one level at a time only as far as it fits within that measured window (never unconditionally to max level — an earlier unconditional-max-boost attempt pushed SASF's own completion past the deadline, caught via self-testing before it reached the user). The boosted chain is only kept if it doesn't push `infraDoneHour` past `firstMobStart`. **Empirical finding**: for India specifically, the `firstMobStart` fix alone closed the gap the boost was meant to fill — zero idle capacity remains to boost into once the primary JIT timing is corrected, so the mechanism exists and is verified functional (via direct construction) but doesn't currently fire for India's real plan. Whether a larger RO-vs-AI joint search (re-opening the RO-level dimension to trade off against AI investment) would recover further headroom is an open question, not yet pursued — flagged for a future round if the electronics/supply deficits warrant it.

6. **Absorption capacity model fix (`evaluateAbsorptionOptions`)** — Sendai was absorbing all 8 of Japan's AWACS demand into itself alone, pushing that city's SASF completion to hour 806 against a 687-hour deadline, with `result.infeasible` silently reporting `false`. Root cause: the absorption cost/capacity estimate assumed every entry in a shared mob queue starts from the same `infraOpenHour`, with no separate accounting for a dead-window filler's much earlier real readiness — so the model let one city absorb far more filler units than its actual idle window could fit before the primary's own JIT start. Fixed with a `deadWindowCapN` cap: for a genuine dead-window filler (`isGenuineDeadWindowFiller`, requirements a *strict* subset of the primary's), the absorbable count is capped by `Math.floor(availableWindow / perUnitMobHours)`, where `availableWindow = primaryJitStart − fillerReadinessAbs`. **One real iteration needed**: the first version of `fillerReadinessAbs` used `scenarioAbsHour + nonRoBuildHours(filler)` — far too optimistic (132h vs. the real ~314h for AWACS in Sendai), because it ignored both the eco phase before flip and `secret_weapons_lab` being built ahead of the filler's own requirements under the dead-window order. Fixed by using `slot.flipPointHour + secretLabHours (if primary needs it and filler doesn't) + filler's own build time` — confirmed via temporary debug tracing (removed once verified) to produce the correct, safe estimate. Result, verified in the real pipeline (`bp-japan.html`): AWACS spreads 1 unit each to Tokyo/Fujisawa/Sendai (the three dead-window cities), remaining 5 correctly absorbed into Oita instead of overcommitting Sendai; all three SASF cities finish exactly at or before the 687h deadline. `evaluateAbsorptionOptions` gained a new required `scenarioAbsHour` parameter to support this — signature-only change, verified via full `npm test` (174 pass / 5 pre-existing failures, unchanged) that no other caller/behaviour regressed.

**Future work, explicitly flagged for reconsideration**: promoting `makeDeadWindowOrderBuildings` to the global default (replacing `makeInfraOrderBuildings` everywhere) once more scenarios exercise the dead-window pattern — per this session's decision, kept scoped/opt-in for now rather than risking regression to the settled RO-first UAT rule elsewhere. `preferred_cities` could also eventually be *derived* automatically from the coalition-wide eco weights (rank a country's cities by whether their resource type is coalition-critical) rather than manually specified per-demand in the plan YAML, as it is for India/Japan today. The RO-vs-AI joint search flagged in item 5 above is also open, pending user direction.

---

## Test Suite — Pre-existing Failures (investigated this session)

`npm test` had 7 failures present before any of the Unit 3 work started (confirmed via `git stash`). Root-caused and triaged:

- **5 failures — left as-is, deliberately out of scope**: `data/scenarios/standard/units/naval_units.yml` and `seasonal_units.yml` are empty placeholder files (`units: {}`) — the standard-tier naval/seasonal unit catalog was never filled in. Causes 2 direct schema-validation failures (`unit-schema.test.ts`) plus 3 cascading `Error: unknown unit "naval_veteran"` / `"epic_airstrike_officer"` failures in `unit-mobilization-plan.test.ts`. This project's focus is the elite/Antarctica tier; standard-tier naval/seasonal data was never a priority.
- **1 failure fixed — stale test expectation**: `cost-calculator.test.ts`'s `"calculateTotalCost returns scalarized building, mobilisation, and upkeep totals"` test asserted pre-triangular-upkeep values (`upkeep: 7.2`) that were never updated after `calculateTriangularUpkeepForConfig` (staggered per-unit upkeep — see Unit 2's Engine Changes) replaced the old flat-upkeep calculation in `225b151`. Hand-verified the triangular formula independently against the test's exact fixture inputs before trusting the code's output — the code was correct, only the test was stale. Updated to `upkeep: 77.23636363636363` / `total: 4187.236363636363`.
- **1 failure fixed — real scheduling bug**: `simulateUnitResearchTargets`'s JIT backward scheduler (`unit-research-sim.ts`) reported a **phantom research segment** for any task that couldn't fit before its deadline: the task was removed from the active scheduling set (`unscheduled`) but the final segment-mapping step still defaulted its missing start/end hours to `scenarioStartHour` instead of dropping it (`?? scenarioStartHour` fallback). This defeated `planMobilizationBuild`'s existing "retry with more cities" safety net (`unit-mobilization-plan.ts`), which only checked segment *existence* for a unit, not whether that segment was genuinely scheduled — so a genuinely infeasible 1-city SASF plan was silently accepted, with SASF L1 shown starting at scenario start hour 15, ~192 hours before its own ASF L4 prerequisite actually finished (hour 207). Fixed by filtering the final `segments` array to only tasks with a real `scheduledStarts` entry; the existing retry-with-more-cities loop (`tryScheduleGroups`) now works exactly as originally designed — no change needed there.

---

## Post-UAT Task List

Tasks deferred until after UAT of the current coalition force plan engine output.

### Testing

1. **Strengthen morale tests** — current coverage is thin (3 tests, ~5 assertions). Add: occupied city morale curve, assertions anchored to real day-1 and day-28 values, edge cases for the D (decay) parameter.

2. **Anchored production test** — add one test that chains the full morale × population → hourly output stack to a known real-world value. Example: pop-6 homeland supplies city, day 1, 4x speed, no buildings → assert exact hourly output. Guards against silent regressions in the core production formula.

3. **Engine regression test** — run `coalition-force-plan` harness on the PNTH plan and assert key numeric outputs: no NaN values, all non-province demands feasible, electronics net balance in expected range (currently −88k). Catches silent regressions in the flip-point solver and coalition aggregation without requiring human HTML review.

4. **README update** — document the new per-country HTML output from coalition runs: `CFP_COUNTRY=all` now writes `tmp/coalition-force-plan.html` (aggregate) + `tmp/cfp-<countryId>.html` per country; `CFP_COUNTRY=<id>` writes a single country file.

### Engine gaps (from Known Gaps table)

5. **Joint demand optimisation per country** — ✅ solved for **Unit 2** (`force-projection.ts` via `joint-city-optimizer.ts`'s fold-in algorithm) — multi-demand countries (e.g. India: SASF+FWV+UAV+cruise+warheads) are optimised as one shared-city problem. Still ⬜ open for the older `coalition-force-plan.ts` harness (per-demand independent optimisation there, unchanged) — that harness is being superseded by the Unit 1/2/3 rebuild rather than fixed directly.

6. **Optimal city subset search** — currently capital-first ordering; combinatorial city-subset search needed for the true optimum.

7. **`mercenary_outpost` in build planner** — ✅ Done, differently than originally planned. **Correction to the design decision below**: `mercenary_outpost` can *only* be built in a **province**, never a city — it does not belong in any city's infra chain at all (the old plan to insert it into "Russia/commando cities" was based on a wrong assumption and was never implemented; nothing needed undoing). It's now a real province-buildable building in the shared simulation engine (`src/engine/orchestration/build-order-timeline.ts`, `src/engine/simulation/province-build-order-sim.ts`) — built once in any province, its `mobilisation_speed_bonus_pct` (0/25/50% by level) and unlock gate apply **country-wide** to all of that country's provinces. A latent bug where it *had* leaked into city infra-chain derivation (`flip-point-solver.ts`'s `CHAIN_ORDER`, `joint-city-optimizer.ts`'s `getBuildingRequirements`) is fixed — both now explicitly exclude it.

8. **Province mobilisation costs** — ✅ Done for **Unit 2** (`force-projection.ts`). New engine module `src/engine/simulation/province-mobilization-plan.ts` (`planProvinceMobilization`): capacity is **one mobilisation slot per province** (same rule as cities; total capacity = country's `provinces.total`), mercenary_outpost build cost/time comes from `data/buildings.yml` (real screenshot data, all 3 levels), mobilisation duration scales with province morale via `effectiveDurationFromMorale` (`src/engine/timing/activity-duration.ts`) then further reduced by mercenary_outpost's country-wide speed bonus. Reuses existing `cost-calculator.ts` functions (`calculateMobilizationCost`, `calculateBuildingCost`, `calculateUpkeepCost`) unmodified — no cost logic duplicated. Wired into `force-projection.ts` in place of the old silent skip; verified end-to-end for Russia's 12 commando (mercenary_outpost L1 build 12h → mobilise 20h → completes hour 32; correct costs and flat upkeep for the remaining truce window). Still ⬜ open for `coalition-force-plan.ts` (three separate skip sites, untouched — superseded harness). **Design decision confirmed**: `combat_outpost` no longer grants a mobilisation speed bonus (already true in `data/buildings.yml` before this session — L1 data had no such field; L2/L3 were simply *missing* from the catalog entirely and have now been added from screenshots, still with no mobilisation-speed field, consistent with the bonus having moved to `mercenary_outpost` at +0/25/50% (L1/L2/L3)).

9. **Flip point now exposed (informational only)** — `force-projection.ts`'s City Mob Build Plans section already computed a correct, whole-queue-aware, JIT-derived infra start time per city (previously an unlabeled local variable, `jitInfraStart`) — it's now explicitly labeled **"Flip point: day X"** in the output. Investigated whether "infra starts at hour 0" (`joint-city-optimizer.ts`'s `infraOpenHour = scenarioAbsHour + totalInfraHours`) was a cost bug — it isn't: `jitStart = Math.max(infraOpenHour, deadlineAbsHour − T)` already always picks the correct latest-feasible value regardless, so no cost numbers changed. Also added a formal `CityMobSlot.flipPointHour` field (computed through absorption too) as a reusable API — a simpler, research-timing-unaware version of the same idea, for future consumers that don't have `combinedResearch.segments` in scope. **✅ Now used to bound/truncate eco income** — `computeCountryForceProjection`'s `flipPointAbsHour` (the research-aware successor to this field) is what Unit 3's `coalition-resource-balance.ts` truncates each city's eco income against, closing the loop this item left open. `CityMobSlot.flipPointHour` itself is still the simpler, research-unaware version, unused by Unit 3.

---

## Iron Pipeline — Hand-Specified, Deterministic Bypass ✅ COVERS ALL 12 PNTH COUNTRIES

### Why This Exists

UAT of the automated coalition-weight eco engine (the beam-search decision-making
layer — `computeCoalitionPlanWeights` → `runActualEcoBuild` → `boostWeightsFromDeficit`,
see UAT Round 3 above) found it miscalibrated: under-invests in short resources
(supplies, electronics), over-invests in resources that are already comfortably
supplied (fuel, components). Rather than debug the automated decision-making layer
directly, the user's direction was to build a parallel, **hand-specified** eco
heuristic — deliberately simple and manually verifiable — reusing the same trusted
simulation primitives (`scheduleBuildSegments`, `simulateBuildOrder`,
`simulateProvinceBuildOrder`, and Unit 2's `computeCountryForceProjection`
**unmodified**) so any discrepancy against the production pipeline's real output is a
signal about the *beam's decision-making*, not about the underlying simulation math
(which both pipelines share and both trust).

Deliberately scoped to Italy first for manual validation before rolling out further —
see the git history / project memory for the original single-country session. This
session extended it to all remaining 11 PNTH V Iron countries and, along the way,
found and fixed three real accounting bugs specific to the iron pipeline's own
hand-rolled aggregation code (not present in the production pipeline, which already
handled these cases correctly via `coalition-resource-balance.ts`).

### The Heuristic

`src/harness/smoke/iron-heuristic.ts` — shared, resource-keyed (not country-keyed)
constants used by every iron script:

- **`AI_TARGET_BY_RESOURCE`** (homeland cities): supplies/electronics/rares → RO1 then
  `arms_industry` straight to L5; components → L1→L2 only; fuel → L1 only. No further
  buildings — no beam continuation.
- **`PROVINCE_BUILD_ORDER`** (homeland provinces): supplies cohorts get
  `L1→L2→L3 local_industry → L1 combat_outpost`; electronics cohorts get
  `L1→L2 local_industry → L1 combat_outpost → L3 local_industry` (a different order
  from supplies — both empirically ROI-positive, transcribed from Italy's real beam
  output). rares/components/fuel/non-resource cohorts: no build, base production only.
- **`OCCUPIED_AI_TARGET_BY_RESOURCE`** (occupied cities): **only** supplies/electronics
  cities get any improvement at all — annex then `arms_industry`→L5. Every other
  resource city (fuel/rares/components) gets **zero** improvements — no annex, stays
  at the base 25% occupied production rate for the whole window. (First implementation
  wrongly annexed every city regardless of resource; corrected immediately when the
  user caught it — "only supply and electronic cities are in scope for annex and arms
  industries.")
- **`OCCUPIED_PROVINCE_BUILD_ORDER`**: supplies **and** electronics cohorts both get
  the *same* sequence (`L1→L2 local_industry → L1 combat_outpost → L3 local_industry`)
  — unlike the homeland map above, where they differ. Provinces can never be annexed
  (`ProvinceBuildAction`'s building set is `local_industry`/`combat_outpost`/
  `mercenary_outpost` only — annexation is a city-only mechanic).
- **Zero yield before `capture_day`** (occupied countries only, from the plan YAML) —
  applies to both city and province production. Nothing in
  `simulateBuildOrder`/`simulateProvinceBuildOrder` enforces this automatically
  (`cityStatus`/`ProvinceState.cityStatus` only controls the production *rate*, not an
  on/off "not ours yet" switch) — both `iron-bp-plan.ts` and `iron-occupied-plan.ts`
  zero it manually, and `BuildAction`/`ProvinceBuildAction`'s `startRelHour` field
  gates the first build action of each city/province so nothing can even start
  building before capture.

### The Five Scripts

All read `IRON_SCENARIO` (default `elite/antarctica`) / `IRON_PLAN` (default
`pnth-v-iron-2026-aug`) / `IRON_COUNTRY` (**required**, no `"all"` batch mode — one
country per invocation, deliberately, unlike the production harnesses' `_COUNTRY=all`
convention) from the environment.

1. **`iron-eco-plan.ts`** → `tmp/iron-eco-<country>.html` — eco build only: City Eco
   Build Plans, Province Eco Build Plans, City Production Summary (full-window gross
   yield). Homeland only.
2. **`iron-fp-plan.ts`** → `tmp/iron-fp-<country>.html` — runs the plan's real demands
   for that country through the **unmodified** Unit 2 engine
   (`computeCountryForceProjection`), standalone/decoupled (no `planWeights`/
   `actualEcoResultsByCity` — infra chains build from scratch, not eco-credited).
   Homeland only.
3. **`iron-bp-plan.ts`** → `tmp/iron-bp-<country>.html` — the real output; integrates
   1+2. RO2 (wherever Unit 2 specified it) is backfilled to the earliest point the eco
   phase's queue is actually free; `arms_industry` from Unit 2's infra chain is
   dropped (already covered by eco); every other infra step (`army_base` etc.) keeps
   its exact original Unit 2 timestamps (no standalone benefit, so no reason to build
   early); mob queue timing is never shifted (stays JIT/deadline-anchored). Also
   computes a full Resource Balance + hourly cash-flow-walk Resource Minima section.
   Homeland only.
4. **`iron-occupied-plan.ts`** → `tmp/iron-eco-<country>.html` **+**
   `tmp/iron-bp-<country>.html` — eco-only (no force projection at all; occupied
   countries have no demands), writes both files in one run since there's no
   separate "fp" stage to merge. Same Resource Balance/Minima shape as `iron-bp-plan.ts`
   (Starting Balance/Mobilisation/Upkeep hardcoded zero) so the aggregate parses it
   identically.
5. **`iron-resource-projection.ts`** → `tmp/iron-resource-projection.html` — the
   coalition aggregate. **Parses the already-generated `tmp/iron-bp-<country>.html`
   files rather than recomputing anything** (explicit user direction, see "Design
   Decision" below) — regex over each file's Resource Balance table, header line,
   Force Projection demand-label line, and (for the pooled minima — see below) an
   embedded JSON `<script>` tag. `IRON_COUNTRIES` env var (comma-separated, default
   `italy,south_africa,pakistan,new_zealand`) selects which countries to pool.

### Design Decision — Parse, Don't Recompute (Then One Deliberate Exception)

First draft of the aggregate re-ran the full eco+force-projection computation for
every country (extracting `iron-bp-plan.ts`'s internals into a shared module). User
rejected this: the per-country HTML files already exist and already contain every
number needed — "it is just a case of reading the iron-bp\<country\>.html and taking
the info from there." Rebuilt as a small regex parser instead; no HTML-parser
dependency needed (none exists in this project — this is the project's own
hand-generated table format, not third-party HTML).

**One deliberate exception**: the Coalition Resource Minima table. Summing each
country's own minima *value* is not a valid pooled minimum — countries hit their own
worst hour at wildly different points in the window (confirmed empirically: some
homeland countries bottom out on day 2, others on day 29, nearly the full 28 days
apart), so summing them treats simultaneous-alignment as fact when it never happens.
Per user direction ("recompute properly from source"), `iron-bp-plan.ts` and
`iron-occupied-plan.ts` now both embed their raw hourly net-flow array as a machine-
readable `<script type="application/json" id="iron-hourly-net-flow"
data-scenario-abs-hour="..." data-resource-order="...">` tag — still no engine
recomputation, just a second, richer data format inside the same already-generated
files. The aggregate parses this, sums real per-hour deltas across all feasible
countries (aligned by hour index), and walks the *summed* series to find the true
minimum, matching how the production pipeline's `computeCoalitionResourceBalance`
pools `hourlyNetFlow` arrays. **Why this distinction matters**: a negative
*per-country* minimum is usually resolvable by redistribution from the shared pool —
not a real constraint. A negative *true pooled* minimum is not resolvable — the whole
coalition is short at that hour, a genuine constraint on the plan as sequenced. Only
the latter is worth getting exactly right.

### Three Real Bugs Found and Fixed via UAT This Session

All three were found by the user noticing a number that looked wrong relative to
another number it should have been comparable to — not by code review. Each led to
tracing the actual data rather than guessing (the one time a guess was made — that
India's warhead upkeep was undercounted by a `unitsPerEvent=1` hardcoding bug — it was
wrong and retracted immediately: `conventional_warhead` has no `daily_upkeep` at all,
so the bug is real but numerically inert).

1. **Unassigned cities' eco income silently dropped to zero.**
   `iron-bp-plan.ts`'s `flipTruncatedCityIncome` loop only iterated
   `result.citySlots` (cities Unit 2's fold-in actually assigned a demand to) — any
   city not needed for a demand (Japan: 3 of 7 cities; Russia: 3 of 7) earned zero
   income while its RO1/`arms_industry` build cost was still charged (that loop
   already covered every city, unconditionally). Surfaced when the user noticed
   Japan's components net balance was "orders of magnitude" worse than India's for no
   demand-driven reason — India happens to use all 7 cities, Japan doesn't. Fixed:
   unassigned cities now contribute full-window (untruncated) income via
   `cityIncomeThroughFlip(city.id, hoursToSimulate)`, in both the totals and the
   hourly walk. A new "Eco-Only Cities (no military demand)" section was added to
   `iron-bp-<country>.html` so every city is visible, not just the assigned ones.
   Verified: the 6 countries using 7/7 cities (italy/south_africa/pakistan/
   new_zealand/india/australia) produced byte-identical output before/after — the fix
   is a genuine no-op where it should be.

2. **Coalition Resource Minima summed each country's own minimum instead of pooling
   real per-hour data** — see "Design Decision" above for the fix. Result: pooled
   minima swung from wildly pessimistic phantom deficits (e.g. supplies −69,826,
   electronics −71,774) to the true walk, where **every pooled resource stays
   positive across the entire 28-day window** — no genuine insolvency point in the
   current plan.

3. **Province build/mobilisation costs were entirely missing from the hourly walk.**
   `costEvents` in both `iron-bp-plan.ts` and `iron-occupied-plan.ts` only ever
   looped over *city* build segments (RO/annex/`arms_industry`) — province segments
   were never added, even though `provinceBuildCost` was correctly included in the
   Resource Balance totals the whole time. Diagnosed with temporary debug
   instrumentation (`IRON_DEBUG_RECONCILE=1` env var, left in both files — opt-in,
   harmless) comparing walked income/cost sums against the totals per resource, run
   against Norway (simplest case: no mob/upkeep/research, isolates the bug to eco
   income/infra cost only). The cost gap was exactly zero for fuel/rares/electronics
   but real for supplies/components/cash — an exact fingerprint match to
   `combat_outpost`/`local_industry`'s actual cost data (those two buildings cost only
   supplies/components/cash, confirmed in `data/buildings.yml`). A second, much
   larger instance explained Russia's outlier-sized gap (cash +232,804 vs ~+15,900
   for similarly-sized countries): province **mobilisation** costs (Commando's
   `mercenary_outpost` build + mob cost + ongoing upkeep) were also never walked.
   Fixed by calling `scheduleBuildSegments` directly for province cohorts (mirroring
   what `simulateProvinceBuildOrder` already does internally) to get real per-step
   start hours, and by adding `result.provinceMobResults`-derived cost events
   (mercenary_outpost build at scenario start, mob cost once it completes — both
   confirmed ASAP/hour-0-start via `country-force-projection.ts`'s own comment — plus
   a flat upkeep rate from completion to deadline, matching the existing
   `garrisonHourlyRate` convention). A smaller, related bug fixed alongside:
   `iron-occupied-plan.ts`'s post-capture province income was divided by the full
   `hoursToSimulate` instead of the post-capture window length
   (`hoursToSimulate - captureRelHour`), under-distributing it. **Verified**: Norway
   reconciles to an exact zero gap on every resource, both income and cost, after the
   fix. Pooled coalition-wide, the walk-vs-totals gap collapsed from tens/hundreds of
   thousands down to low hundreds (e.g. electronics +18,787 → +1,737, cash +334,395 →
   −49) — now normal rounding/approximation noise, not a structural omission. The true
   pooled minima shrank accordingly once the walk started deducting costs it had been
   silently skipping (electronics minima +21,325 → +4,545) — thinner margins, still
   positive, still no genuine insolvency point.

### Result vs. the Production Pipeline (all 12 countries, post-fix)

| Resource | Prod Net | Iron Net | Note |
|---|---|---|---|
| supplies | −15,416 | +106,505 | prod deficit — known under-investment |
| components | +130,357 | +52,933 | prod surplus, likely over-invested |
| fuel | +75,538 | +20,851 | prod surplus, likely over-invested |
| rares | +154,351 | +233,812 | both surplus |
| electronics | −103,957 | +9,825 | prod deficit — known under-investment |
| cash | +134,479 | +753,952 | iron far ahead |

Framing that matters more than the column-by-column tally: a bigger components/fuel
surplus for prod is just idle resources that could have funded something else — not a
"win" in any meaningful sense. A deficit means the plan as computed literally cannot
be paid for as sequenced. Prod fails that test twice (supplies, electronics); iron
fails it zero times. Prod's "wins" on components/fuel are exactly the two resources
the beam has been flagged as over-investing in since the original Italy session — this
whole-coalition run is confirmation at scale, not just a single-country anecdote.

### Known Open Issues (flagged for UAT, not yet fixed)

- ~~Dead-window city sharing doesn't reproduce in the decoupled iron run~~ — **fixed**,
  see "India/Japan Dead-Window Fixes" below. Both bullets that used to be here (the
  no-sharing symptom and the `WARNING: RO2 backfill ... runs past the original infra
  start` banners) traced to the same root cause: `makeDeadWindowOrderBuildings`
  front-loading `secret_weapons_lab` ahead of `air_base`, and `iron-bp-plan.ts`'s
  RO2-backfill logic never reconciling its own timestamps against that ordering.
- No optimal city-subset search (inherited limitation, same as the production
  pipeline) — capital-first-ish ordering from Unit 2's fold-in.

### Diagnosed But Not Fixed — Unit 3's Coalition Eco-Investment Weight Formula

Not an iron-pipeline bug — a real defect in the **production** pipeline
(`computeCoalitionPlanWeights`/`boostWeightsFromDeficit`, `joint-city-optimizer.ts`),
diagnosed by comparing prod against the now-validated iron baseline above. Parked for
a future session ("this is for another time") — recorded here so the diagnosis isn't
lost.

**Symptom**: prod has two real coalition-wide deficits (supplies −15,416, electronics
−103,957) that iron doesn't have, while iron runs a smaller components/fuel surplus
than prod.

**Root cause, diagnosed in two steps, both from data already sitting in the balance
sheets — no new instrumentation needed**:

1. **Cash pollutes the weight formula.** `weight[resource] = Σ mobilisation_cost[r] ×
   count + Σ daily_upkeep[r] × count × remaining_days` is currently computed across
   all resource keys, including cash — but cash is never a city's native `resource`
   field (no city produces it directly; it only ever shows up as `arms_industry`'s
   flat per-level bonus). Since unit mob/upkeep costs typically have cash components
   an order of magnitude larger than any material resource, cash's raw cost magnitude
   crowds out the material-resource signal the formula is supposed to be measuring.
   Fix: exclude cash (and manpower, same reasoning — no city produces manpower
   either) from the weight formula entirely, not just down-weight them.

2. **The formula has no capacity/scarcity term at all — it's pure demand.** Confirmed
   by computing `cost[r] / income[r]` (income only — **not** gross available, which
   includes the one-time starting balance and understates true ongoing utilization)
   for both pipelines, from numbers already in each Coalition Balance Sheet:

   | Resource | Iron util | Prod util | Delta |
   |---|---|---|---|
   | electronics | 115.2% | 153.4% | prod +38pt worse |
   | supplies | 116.1% | 131.3% | prod +15pt worse |
   | cash | 109.4% | 137.4% | prod +28pt worse |
   | components | 122.2% | 110.8% | prod −11pt better |
   | fuel | 121.5% | 106.9% | prod −15pt better |
   | rares | 48.5% | 64.7% | prod +16pt (slack in both) |

   Prod runs electronics/supplies materially hotter than iron while running
   components/fuel more comfortably — ~11-15 points of headroom parked in
   components/fuel that electronics/supplies don't have. Rares is slack in both
   pipelines (nowhere near its production ceiling), the clearest resource to pull
   investment from if something needs funding.

**Proposed fix, in order** (not yet started):
1. Instrument the current formula to confirm cash's contribution magnitude directly
   (the diagnosis above is inferred from outcomes, not yet observed in the formula's
   own intermediate values).
2. Exclude cash/manpower from the weight formula.
3. Rework `boostWeightsFromDeficit`'s single fixed-size boost pass into something that
   iterates toward `cost[r]/income[r]` parity across resources, rather than stopping
   after one round (CLAUDE.md's UAT Round 3 section already flags "a second boost
   round would likely narrow further... not implemented" — this generalizes that idea
   into a real convergence target instead of a second fixed pass).
4. Re-validate against the iron baseline (`npm run smoke:iron-resource-projection`)
   after each step — the target is prod's `cost/income` ratios landing close to level
   across resources, not skewed 153%/131% on two resources and 107%/111% on two
   others.

---

## India/Japan Dead-Window Fixes + `min_ro` Pinning (session, 2026-08-14)

UAT of India's `tmp/bp-india.html`/`tmp/iron-bp-india.html` surfaced four real
engine bugs and one data gap, all found by the user spot-checking generated output
against known game mechanics and in-game research-tree screenshots rather than by
code review. All fixed and verified; India and Japan both confirmed correct by the
user in the final review.

### Four engine bugs fixed (general, not India-specific)

1. **`computeEcoBackfill` aborted its whole backfill walk on the first level that
   didn't fit** (`flip-point-solver.ts`) — instead of skipping just that building
   and trying the next one in order. Since `air_base` (the long-pole in any genuine
   dead-window city) almost always overflows the idle window on its own, and it sat
   before `recruiting_office` in `makeDeadWindowOrderBuildings`'s order, RO2/RO3
   never got a chance to backfill even when it would trivially fit. Fixed:
   `break outer` → `break` (skip, don't abort) — a strict superset of what the walk
   already attempted, so it can't cause double-processing or ordering violations.

2. **Launcher-platform units (missiles) were excluded from research scheduling
   entirely, not just mobilisation** (`country-force-projection.ts`).
   `conventional_cruise_missile`/`ballistic_missile` correctly never get a city
   mob-queue slot (`classifyDemands` routes them to `launcherDemands`), but the
   research-target loop only iterated `activeDemands`-derived results — so their
   real, full per-level research data (confirmed against user screenshots this
   session — day 6/11/15/18/24 unlock days, matching exactly) was never fed to
   `simulateUnitResearchTargets` at all. Fixed: `launcherDemands` now also feed
   `researchTargets`/`unitDemandCounts`, with no `latestCompletionByUnitLevel`
   anchor (they have no mob-queue to derive one from — the existing low-impact-
   score priority rule schedules them reasonably on its own).

3. **Zero-upkeep primary units in single-unit-queue cities were needlessly
   deadline-JIT-anchored** (`country-force-projection.ts`). Bengaluru/Chennai's
   `conventional_warhead` (zero `daily_upkeep` in every doctrine) sat idle ~7 real
   days between finishing its one requirement (`secret_weapons_lab` L1) and
   mobilisation actually starting — deadline-JIT-anchoring only makes sense to
   *save* upkeep-days, which a zero-upkeep unit has none of. Fixed: when a
   queue's every entry has `upkeepRateScalar === 0`, drop the
   `deadline − usedHours` term from both `firstMobStart` and the per-entry
   `mobStart` formula.

4. **`conventional_cruise_missile` was missing its real research-tree
   prerequisite** (`ballistic_missile level 1`) — `requirements: []` on all 6
   levels. Confirmed from the user's in-game research-tree screenshots
   (`RESEARCH | EASTERN`): the tree shows `conventional_warhead` (Guided Missile
   Program) → `ballistic_missile` → `conventional_cruise_missile`, a real
   two-hop chain, not the single hop originally assumed. Also confirmed missile
   *research* has no building requirement at all (unlike warhead *mobilisation*,
   which does need `secret_weapons_lab`) — an earlier diagnosis this session
   assumed the opposite and was corrected before landing.

### `ballistic_missile` added to the elite catalog

`missile_units.yml` — research-only (`category: Missile`, all 3 doctrines), L1
data from the user's screenshot ("Scud": unlock day 2, 21h, 2250 supplies/2500
fuel/7000 cash — confirmed doctrine-generic, not a placeholder), requires
`conventional_warhead level 1`. Mobilisation is a zero-cost/zero-time structural
placeholder matching `conventional_cruise_missile`'s existing pattern — the real
warhead-consumption mobilisation model is still a pending schema extension (see
the `# TODO` comments in the file), deliberately out of scope this session.
Levels 2+ undefined pending more screenshots.

### India plan redesign — `preferred_cities` pinning

`pnth-v-iron-2026-aug.yml`: `conventional_warhead` (240, 60 slots) moved off
Mumbai/Kolkata/New Delhi entirely onto the fuel/components-tile cities
(Bengaluru/Chennai/Ahmedabad, 20 slots each) — eliminates the RO2-starvation
pressure at its root rather than just relying on bug 1's fix to recover it from
an already-crowded dead-window queue. `uav` and `fixed_wing_veteran` moved into
the SASF cities' now-freed dead-window capacity instead. Hyderabad (rares) drops
to eco-only — it no longer needs a dedicated `air_base L1` investment purely for
`fixed_wing_veteran`, since New Delhi already builds that as a byproduct of its
own `air_base` climb for SASF. Added `ballistic_missile` as a new demand (count
120, mirrored from `conventional_cruise_missile` as an explicit placeholder — no
real target count given).

**A latent bug found while implementing this**: `foldInDemands`'s pinned pre-pass
(`joint-city-optimizer.ts`) created a *duplicate* `CityMobSlot` when two separate
pinned demands named the same city (e.g. SASF and `uav` both pinned to Mumbai) —
each opened its own disconnected slot instead of merging into one shared
dead-window queue. Never exercised before this session because only one demand
(SASF) had ever used `preferred_cities`. Fixed by routing the second pin through
the existing absorption machinery (`evaluateAbsorptionOptions`/`applyAbsorption`)
when a slot for that city already exists. Flagged to the user as an unplanned
change to shared fold-in logic; user's direction was to keep it but treat any
*further* changes to this function as "strategic core logic" they want to
personally validate before it's touched again — not urgent, no action pending.

### `secret_weapons_lab` build-order rule reworked

`makeDeadWindowOrderBuildings` used to front-load `secret_weapons_lab` ahead of
`arms_industry`/`air_base` specifically to unlock `conventional_warhead`'s
mobilisation-eligibility early. Once warhead was pinned away from the SASF
cities (above), that justification stopped applying to Mumbai/Kolkata/New
Delhi's queues — and front-loading it there was actively wrong, since
`secret_weapons_lab` has zero eco value (`production_bonus_pct`) while
`arms_industry`/`air_base` have real value while being built. Reworked
unconditionally (not conditional on filler composition) to just fold it into
the normal ecoScore-sorted group — `recruiting_office` still forced last,
unchanged. Applies to every dead-window city regardless of role, per user
direction: AI (arms_industry) levels are set deterministically per city
(`AI_TARGET_BY_RESOURCE`, not derived per-filler), and warhead-producing cities'
AI target is low anyway (fuel: L1; components: L1→L2), so deferring
`secret_weapons_lab` costs little there even though warhead does need it.

### Iron Pipeline fixes (`iron-bp-plan.ts`)

Moving `secret_weapons_lab` after `air_base` (above) shifted Unit 2's own
`air_base` chain to start *earlier* than before — `iron-bp-plan.ts`'s separate,
hand-rolled RO2-backfill logic (which pulls RO2 forward to "the earliest free
point" while claiming every other infra step "keeps its exact original
force-projection timestamps unaltered") was never updated to account for that
shift, so the two became internally inconsistent (RO2's backfill overlapping
`air_base`, surfaced as `WARNING: RO2 backfill ... runs past the original infra
start` on every affected city).

Fixed:
- RO2's backfill now genuinely precedes the rest of the chain (real
  reschedule, not just a warning); RO3+ (when the target RO level is ≥3) is
  deferred to build *after* `secret_weapons_lab` instead of pulled forward with
  RO2 — user's direction, closes most of the resulting gap since RO3 has no
  standalone benefit before it's needed.
- **A real, separate pre-existing bug found along the way**: the RO-backfill
  step only ever counted the *last* hop's cost/duration (`.find(toLevel ===
  roLevel)` picks one step object) — e.g. just the L2→L3 leg (28h) for an RO L3
  target, silently dropping the L1→L2 leg (26h) entirely from both the
  reschedule math and the Resource Balance's RO2-backfill cost total. Fixed by
  summing every hop from eco's credited L1 up to the target level.
- Filler mob-start floors (uav etc.) are re-derived from the rescheduled infra
  timestamps — but **only when a real RO2+ backfill exists** for that city.
  An earlier version of this fix rescheduled `otherSteps` unconditionally for
  *every* city, including RO L1 cities with no backfill at all — this forced
  Japan's Oita/Tokyo/Fujisawa/Sendai `air_base` chains to start at the iron-eco
  heuristic's own completion hour instead of Unit 2's own already-correct,
  already-validated (UAT Round 3) earlier timing, producing an 84h spurious gap
  on Tokyo. Caught before shipping by checking Japan's output too, not just
  India's — fixed by scoping the reschedule to fire only when `roStep` (the
  RO2 hop) actually exists.
- A primary unit's own mob start now delays to match its rescheduled infra
  chain's completion when there's a small residual gap (Mumbai/Kolkata were
  ~1-2h short) — "that is what will happen in practice," per the user, rather
  than leaving a warning banner. Can only push a start *later*, never earlier,
  so it can't turn a feasible plan infeasible.

### `min_ro` — new plan-level pinning capability

`estimateRoLevelForFixedCityCount` (`joint-city-optimizer.ts`) always picks the
*cheapest* RO level that fits a pinned demand's own count — so when a second
demand is later pinned to the same city (e.g. AWACS sharing SASF's cities),
there was no way to make the *first* demand's pin choose a higher RO level than
it alone would ever need. Added `Demand.min_ro?: number` (optional, 1-5,
`coalition-force-plan-schema.ts`) — threaded into the pinned pre-pass as
`Math.max(getUnitMinRo(unitId, catalog), demand.min_ro ?? 0)`. Once the first
pin establishes `slot.roLevel` at the forced floor, a later pinned demand
sharing the same city inherits it via the existing absorption merge (no further
engine change needed — `evaluateAbsorptionOptions` already computes
`neededRo = Math.max(slot.roLevel, minRo)`).

### Japan redesign

Used `min_ro` to drop AWACS's separate dedicated `air_base L4` investment in
Oita (fuel — Japan's lowest-weighted resource) in favour of pushing AWACS
capacity into Tokyo/Fujisawa/Sendai (Japan's SASF dead-window cities), per user
direction. `stealth_air_superiority_fighter` demand gets `min_ro: 3` (would
otherwise settle for RO1, unaware AWACS will share the queue); `awacs` (8) and
`fixed_wing_veteran` (1, pinned to Tokyo — Japan's capital) both get
`preferred_cities: [tokyo, fujisawa, sendai]` / `[tokyo]`. Oita drops to
eco-only.

**Investigated, left as-is**: user initially wanted `fixed_wing_veteran` to
mobilise before AWACS in Tokyo (matching the earlier India ask for the same
pattern). Traced to a real, already-documented gap: the Iron Pipeline's
decoupled mode (no `actualEcoResultsByCity`) doesn't credit `recruiting_office`
early the way the real eco-credited pipeline does (`forceRO` in
`city-eco-beam.ts`) — so in this fallback, RO is subject to the same
`makeDeadWindowOrderBuildings` ordering as everything else (RO forced *last*).
`fixed_wing_veteran` uniquely requires `recruiting_office level 1` as a unit
requirement (unusual — most units don't), so its readiness gets pushed almost
to the end of the whole chain in this decoupled path, while AWACS (needs only
`air_base L4`, no RO) becomes ready much earlier — hence AWACS mobilises first.
Confirmed this is Unit 2's own unmodified output, not caused by anything this
session touched. User's call: leave it (AWACS before FWV in Tokyo stands).

### Global: rares AI target capped at L3

`iron-heuristic.ts`'s `AI_TARGET_BY_RESOURCE.rares` — was `5` (same as
supplies/electronics), now `3`, per user direction ("pin rare cities to arms
industry 3 at most" — applies across the air builds and the MRL builds, i.e.
every rares-tile city in every country's Iron Pipeline run, not India/Japan-
specific).

### Verification

`npm test`: only the 5 pre-existing baseline failures (naval/seasonal empty
catalogs). India and Japan Iron Pipeline output (`iron-bp-india.html`,
`iron-bp-japan.html`) regenerated and confirmed correct by the user.

### Next steps (flagged, not started)

User's stated next focus for a future session: **review the mechanized
infantry and commando builds** — likely Australia's `mechanized_infantry` (30,
+ `mobile_anti_air_vehicle` 70 + `mobile_radar` 7) and Russia's `commando` (12,
province-mobilised) demands in the current PNTH V Iron plan, applying the same
kind of UAT scrutiny (Iron Pipeline output vs. expected game mechanics) that
surfaced this session's India/Japan fixes. Not yet investigated — no findings
to report yet, just the stated intent to pick this up next.
