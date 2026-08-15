# Hephaestus

A TypeScript planning engine for a strategy game. It simulates and optimises how a country researches and mobilises military units before a truce deadline, finding the cheapest city/recruiting-office configuration to field a target force in time.

## Structure

```
src/
  core/                   Shared constants and time utilities
  schemas/                Zod validators for all YAML data files
  scenarios/io/           Filesystem and YAML loaders (buildings, scenarios, countries)
  engine/
    economy/              Morale, population, city/province production, building modifiers
    eco/                  City + province eco beam search, flip-point solver, income-through-flip truncation
    optimization/         Force projection, batch allocation, research scheduling, cost calculator, joint-city optimizer, per-country force projection, garrison upkeep
    orchestration/        Build order timeline
    provinces/            Province cohorts
    reporting/            Country resource balance, coalition resource balance, scenario reporting
    simulation/           Unit research, mobilisation, build-order, and province-mobilisation simulations
    timing/               Shared timing helpers
  cli/                    Entry point scripts
  harness/smoke/          Ad-hoc runner scripts (not tests)
  test-support/           Shared test helpers

data/
  buildings.yml
  enums.yml
  scenarios/
    standard/
      units/              Unit catalog shared across standard scenarios
      ww3/                Standard WW3 scenario + country configs
    elite/
      units/              Unit catalog shared across elite scenarios
      ww3/                Elite WW3 scenario + country configs
      antarctica/         Elite Antarctica scenario + country configs
```

## CLI

```bash
# Run the force planner for a country
npm run plan

# Validate a single country YAML
npm run validate:country

# Validate all country YAMLs
npm run validate:countries

# Convert Beam City HTML export to a build plan YAML
npm run convert:beam-city:build-plan
```

## Smoke Scripts

Ad-hoc scripts for spot-checking models from the command line.

### Economy

```bash
npm run smoke:morale                        # Homeland morale curve
npm run smoke:morale:occupied               # Occupied city morale curve
npm run smoke:multipliers                   # Daily morale and population multipliers
npm run smoke:resource                      # Daily city resource production
npm run smoke:resource:hourly               # Hourly city production and running balances
npm run smoke:argentina:hourly              # Hourly country-level balances (Argentina)
npm run smoke:country:economy               # Country economy summary
```

### Build Orders

```bash
npm run smoke:build-order                   # Single-city AI1→AI5 build order
npm run smoke:build-order:compare           # Compare AI5→B3 vs B3→AI5 over 28 days
npm run smoke:build-plan:balance            # Build plan resource balance
npm run smoke:greece:electro                # Greece electronics city benefit
```

### Coalition Force Planning (Unit 1 + Unit 1.5 + Unit 2 + Unit 3)

Current active plan: `data/scenarios/elite/antarctica/plans/pnth-v-iron-2026-aug.yml`
(pass `ECO_PLAN=pnth-v-iron-2026-aug` / `FP_PLAN=pnth-v-iron-2026-aug` explicitly —
neither harness's code default points at it yet; `RP_PLAN` is required with no
default, so it must always be passed). Roster/rationale documented in
`data/scenarios/elite/antarctica/coalition-plan.md`.

```bash
# Unit 1 — Eco Planner: theoretical, per-city-isolated optimal eco build sequence
# (a reference ceiling — NOT what drives Unit 3's cost/income; see Unit 1.5)
ECO_COUNTRY=all npm run smoke:eco-plan                  # all countries in default scenario
ECO_PLAN=pnth-v-iron-2026-aug ECO_COUNTRY=all npm run smoke:eco-plan   # every country in the plan (this is the default when a plan is loaded)
ECO_COUNTRY=norway npm run smoke:eco-plan               # single country
ECO_PLAN=pnth-v-iron-2026-aug ECO_COUNTRY=norway npm run smoke:eco-plan   # plan-aware: reads status + capture_day from the plan, not just the country YAML
# Config: ECO_SCENARIO, ECO_PLAN, ECO_COUNTRY, ECO_BEAM_WIDTH, ECO_TOP_N

# Unit 1.5 — Actual Eco Build: Unit 1's beam engine reweighted by the force plan's
# real resource footprint, relocate_headquarters capped to one city. Not a standalone
# harness — runs inside Unit 3 (resource-projection.ts) via runActualEcoBuild.

# Unit 2 — Force Projection (⚠ deprecated, see Unit 3 below): JIT research +
# min-cost mobilisation plan, incl. province-mobilised units (commando etc.) and
# per-city flip points. Not eco-credited — bp-<country>.html (Unit 3) supersedes it.
FP_PLAN=pnth-v-iron-2026-aug FP_COUNTRY=all npm run smoke:force-projection   # all plan countries
FP_PLAN=pnth-v-iron-2026-aug FP_COUNTRY=russia npm run smoke:force-projection   # single country
FP_MAX_RO=3 FP_COUNTRY=indonesia npm run smoke:force-projection
# Config: FP_SCENARIO, FP_PLAN, FP_COUNTRY, FP_MAX_RO

# Unit 3 — Resource Projection: runs Unit 1.5 + Unit 2 internally, combining actual
# eco income (truncated at each city's real, eco-credited flip point) + force costs +
# garrison upkeep into a coalition balance sheet (pooled resources), an hourly
# cash-flow minima walk, and a per-country manpower check. Writes the coalition
# aggregate (tmp/resource-projection.html) + one tmp/bp-<countryId>.html per country
# (balance + research + combined eco/military infra timeline + cost summary).
# A demand can carry `preferred_cities` (plan YAML) to pin it to named cities and
# enable dead-window city sharing — a long-pole unit's city mobilises a cheaper
# filler unit (e.g. warheads/UAV/AWACS alongside SASF) during its own idle build
# time. See CLAUDE.md's "UAT Round 3" section for the full mechanic. A pinned
# demand can also carry `min_ro` to force a higher recruiting_office floor than
# it alone would need, when a later demand will share the same pinned cities
# and needs more mobilisation throughput (see CLAUDE.md's "India/Japan
# Dead-Window Fixes" section).
RP_PLAN=pnth-v-iron-2026-aug RP_COUNTRY=all npm run smoke:resource-projection   # RP_PLAN is required — no default
RP_PLAN=pnth-v-iron-2026-aug RP_COUNTRY=russia npm run smoke:resource-projection   # single country
# Config: RP_SCENARIO, RP_PLAN (required), RP_COUNTRY, RP_MAX_RO, RP_BEAM_WIDTH, RP_TOP_N, RP_GARRISON_DISBAND_DAY, RP_OUTPUT_FILE
```

### Iron Pipeline (hand-specified, deterministic bypass)

A parallel, hand-specified alternative to the coalition-weight beam above — a fixed
resource-keyed eco heuristic (RO1 everywhere; `arms_industry`→L5 for
supplies/electronics/rares cities, lower targets for components/fuel) plus the
existing, unmodified Unit 2 engine, used to sanity-check whether the beam's automated
investment decisions are actually well-calibrated. See CLAUDE.md's "Iron Pipeline"
section for the full history, including three real accounting bugs this exercise
surfaced and fixed. Covers all 12 countries in the active PNTH V Iron plan (8
homeland + 4 occupied).

```bash
# Homeland countries (demands from the plan YAML) — 3 files per country:
IRON_COUNTRY=italy npm run smoke:iron-eco-plan   # tmp/iron-eco-italy.html — eco build only
IRON_COUNTRY=italy npm run smoke:iron-fp-plan    # tmp/iron-fp-italy.html — force projection only
IRON_COUNTRY=italy npm run smoke:iron-bp-plan    # tmp/iron-bp-italy.html — merged, the real output
# Config: IRON_SCENARIO, IRON_PLAN, IRON_COUNTRY (required)

# Occupied countries — eco-only, no force projection, annex+AI5 restricted to
# supplies/electronics cities, zero yield before capture_day. A city/province
# credited to a homeland country (plan YAML's city_credits/province_credits — see
# CLAUDE.md) is excluded here and appears in that homeland's own iron-bp-<id>.html
# instead, so a captured country's own file may legitimately show zero cities:
IRON_COUNTRY=norway npm run smoke:iron-occupied-plan   # tmp/iron-eco-norway.html + tmp/iron-bp-norway.html

# Per-city exceptions to the shared heuristic (OCCUPIED_CITY_EXTRA_FIRST_BUILD in
# iron-heuristic.ts) live outside the resource-keyed rules above — e.g. Kristiansand
# (credited to Australia) builds underground_bunkers L1 before annex_city, beam-search
# validated as a small net-positive at its population specifically, not a blanket rule.

# Coalition aggregate — parses the already-generated tmp/iron-bp-<country>.html
# files (does not recompute) and pools them, including a true hour-aligned pooled
# minima walk (not a naive sum of each country's own minimum — see CLAUDE.md):
IRON_COUNTRIES=italy,south_africa,pakistan,new_zealand,norway,madagascar,solomon_islands,iran,india,japan,russia,australia \
  npm run smoke:iron-resource-projection   # tmp/iron-resource-projection.html
# Config: IRON_COUNTRIES (comma-separated, defaults to the first 4), IRON_OUTPUT_FILE
```

### Research and Force Planning

```bash
npm run smoke:research                      # Unit research schedule
npm run smoke:research:elite-ww3            # Elite WW3 unit research schedule
npm run smoke:force-plan                    # Force build plan
npm run smoke:force:elite-ww3              # Elite WW3 force validator
npm run smoke:mobilization:elite-ww3       # Elite WW3 unit mobilisation
```

### Country-Specific (Elite WW3)

```bash
npm run smoke:turkey:plan:elite-ww3
npm run smoke:turkey:elite-ww3
npm run smoke:turkey:economy:elite-ww3
npm run smoke:iraq:elite-ww3
npm run smoke:iraq:economy:elite-ww3
npm run smoke:iraq:plan:elite-ww3
npm run smoke:greece:occupied:elite-ww3
npm run smoke:indonesia:philippines:elite-ww3
npm run smoke:hq:timing:elite-ww3
```

### Coalition / Multi-Country

```bash
npm run smoke:coalition:elite-ww3
npm run smoke:coalition:ww3-2026
npm run smoke:city-builds:elite-ww3
```

### Beam Search and Optimisation

```bash
npm run smoke:beam:city                     # City-level beam search
npm run smoke:beam:country                  # Country-level beam search
npm run smoke:beam:occupied-target          # Occupied city target beam
npm run smoke:beam:portfolio                # Portfolio balance beam
npm run smoke:mc:city:elite-ww3            # City Monte Carlo (Elite WW3)
```

The Beam scripts accept environment variables to select scenario and country:

```bash
BS_SCENARIO=elite/antarctica BS_COUNTRY=argentina npm run smoke:beam:city
BSC_SCENARIO=elite/antarctica BSC_COUNTRY=argentina npm run smoke:beam:country
```

## Tests

```bash
npm test
```
