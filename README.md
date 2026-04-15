# ww3-builld-plan

## Structure

- `src/engine/` contains pure simulation, economy, orchestration, and reporting logic.
- `src/schemas/` contains Zod schemas and object-level parsing/validation.
- `src/scenarios/io/` contains filesystem and YAML loaders for buildings, scenarios, enumerations, and countries.
- `src/harness/smoke/` contains scenario-driven smoke scripts.
- `src/cli/` contains validation entrypoints.

## Smoke Tests

The repo includes a set of smoke scripts for checking the economy, morale, and build-order models from the command line.
The smoke entrypoints now live under `src/harness/smoke/`, separate from the engine code in `src/engine/`.

Run them with:

```bash
npm run smoke:morale
npm run smoke:multipliers
npm run smoke:resource
npm run smoke:resource:hourly
npm run smoke:argentina:hourly
npm run smoke:build-order
npm run smoke:build-order:compare
npm run smoke:beam:city
npm run smoke:beam:country
```

The Beam scripts are scenario-driven and take their main inputs from environment variables:

```bash
BS_SCENARIO=elite_ava_feb_2026 BS_COUNTRY=argentina npm run smoke:beam:city
BSC_SCENARIO=elite_ava_feb_2026 BSC_COUNTRY=argentina npm run smoke:beam:country
```

### Scenario Ground Truth

Smoke scripts use `data/scenarios/elite_ava_feb_2026/scenario.yml` as the source of truth for:

- `start.day`
- `start.hour`
- `speed`
- `starting_balance` where the model being exercised includes balances

The scenario loader normalizes `starting_balance.rare` from YAML to the internal resource key `rares`.

Hourly and daily reporting now use map time, not "24 hours since scenario start":

- absolute hour = `(mapDay - 1) * 24 + hour`
- map day boundaries are fixed calendar windows `[0,24)`, `[24,48)`, ...
- a scenario that starts mid-day reports a partial first map day
- hourly morale ticks at calendar midnight (absolute hour multiples of `24`)

### Scripts

`smoke:morale`

- Prints the baseline homeland morale as a map-time table.
- Uses scenario start time for display context.
- Prints `day`, `hourOfDay`, and `morale`.
- Does not use starting balances.

`smoke:multipliers`

- Prints daily morale and population multipliers.
- Uses scenario start time for display context.
- Prints `day`, `morale`, `moraleMul`, `popDecimal`, and `popMul`.
- Rounds `popDecimal` to 1 decimal place and `popMul` to 2 decimal places.
- Does not use starting balances.

`smoke:resource`

- Loads Argentina's Buenos Aires city from scenario country YAML.
- Prints daily production for that city's resource plus `manpower` and `cash`.
- Uses scenario `speed`.
- Uses hourly-to-daily rollup over fixed map-day windows.
- Prints a partial first day when the scenario starts mid-day.
- Prints `hoursCounted` for each map day.
- Uses the city's `resource` value as the dynamic resource column label.
- Prints scenario start time and starting balances for context.

`smoke:resource:hourly`

- Prints hourly production and running balances for a single example city resource plus `manpower` and `cash`.
- Uses scenario `speed`.
- Uses scenario `starting_balance` for the displayed resource, `cash`, and `manpower`.
- Uses calendar day for morale ticks, so morale changes at absolute hours `24`, `48`, `72`, ...
- Prints `day`, `hourOfDay`, and `morale` alongside hourly production and balances.

`smoke:argentina:hourly`

- Loads `data/scenarios/elite_ava_feb_2026/countries/argentina.yml`.
- Aggregates hourly country balances for `supplies`, `components`, `fuel`, `electronics`, `rare`, `manpower`, and `cash`.
- Uses scenario `speed`.
- Uses scenario `starting_balance`.
- Uses fixed map-day/hour labels derived from absolute time.
- Prints `day` and `hourOfDay` alongside the country balance columns.
- Starts on the scenario start hour and truncates output at the end of the requested map-day window.

`smoke:build-order`

- Runs a single-city Arms Industry build order from AI1 through AI5.
- Uses scenario start day/hour as the base clock for all completion and activation timing.
- Prints:
  - scenario start and absolute `t0`
  - per-build `start_rel_hour`, `duration_hours`, `completion_abs`, `activationDay`
  - per-day `dayStart_abs` and bunker level at day start
  - hourly production table with absolute hours, morale, and multiplier

`smoke:build-order:compare`

- Compares two single-city build orders over the first 28 map days:
  - `AI5 -> B3`
  - `B3 -> AI5`
- Uses Argentina's Buenos Aires city as the exemplar input.
- Uses the shared city economic inputs directly from the city's starting population, produced resource, and scenario speed.
- Prints per-build timings, final cumulative output, and day-by-day cumulative deltas for the city resource and cash.

## Tests

Run the automated tests with:

```bash
npm test
```
