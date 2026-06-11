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
    eco/                  City + province eco beam search, flip-point solver
    optimization/         Force projection, batch allocation, research scheduling, cost calculator, joint-city optimizer
    orchestration/        Build order timeline
    provinces/            Province cohorts
    reporting/            Country resource balance, scenario reporting
    simulation/           Unit research, mobilisation, and build-order simulations
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

### Coalition Force Planning (Unit 1 + Unit 2)

```bash
# Unit 1 — Eco Planner: optimal eco build sequence per city
ECO_COUNTRY=all npm run smoke:eco-plan                  # all countries in default scenario
ECO_PLAN=pnth_v_road_2026_jun ECO_COUNTRY=all npm run smoke:eco-plan   # coalition members only
ECO_COUNTRY=norway npm run smoke:eco-plan               # single country
# Config: ECO_SCENARIO, ECO_PLAN, ECO_COUNTRY, ECO_BEAM_WIDTH, ECO_TOP_N

# Unit 2 — Force Projection: JIT research + min-cost mobilisation plan
FP_COUNTRY=all npm run smoke:force-projection           # all plan countries
FP_COUNTRY=norway npm run smoke:force-projection        # single country
FP_MAX_RO=3 FP_COUNTRY=indonesia npm run smoke:force-projection
# Config: FP_SCENARIO, FP_PLAN, FP_COUNTRY, FP_MAX_RO
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
