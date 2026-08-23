# Session History

This is the session-by-session narrative — bugs found, investigated, and fixed — that
used to live inline in `CLAUDE.md`. It was split out on 2026-08-23 (see F9 of the
[architecture review](../..)) because `CLAUDE.md` is loaded in full at the start of
every session, and a chronological bug-fix log doesn't need to be resident context —
the durable architecture and current plan state that remain in `CLAUDE.md` do.

**This file is historical record, not current state.** Numbers quoted here (test
pass/fail counts, coverage, in-progress caveats) reflect what was true *at the time
each entry was written*, not necessarily today. Where an entry's own claim has since
been superseded, it's usually noted inline (e.g. "Superseded: ..."); where it isn't,
check the code rather than trusting the number. For the current, accurate picture —
schema shapes, what's built, what's still open — see `CLAUDE.md` itself.

Ordered oldest-relevant-first as it was in `CLAUDE.md`; not a strict chronological
diary (a few entries reference sessions out of the order they appear).

---

## Test Suite — Pre-existing Failures (investigated this session)

`npm test` had 7 failures present before any of the Unit 3 work started (confirmed via `git stash`). Root-caused and triaged:

- **5 failures — left as-is, deliberately out of scope**: `data/scenarios/standard/units/naval_units.yml` and `seasonal_units.yml` are empty placeholder files (`units: {}`) — the standard-tier naval/seasonal unit catalog was never filled in. Causes 2 direct schema-validation failures (`unit-schema.test.ts`) plus 3 cascading `Error: unknown unit "naval_veteran"` / `"epic_airstrike_officer"` failures in `unit-mobilization-plan.test.ts`. This project's focus is the elite/Antarctica tier; standard-tier naval/seasonal data was never a priority. **Superseded**: those 5 tests were removed in `5054886`, and `data/scenarios/standard/` itself was deleted entirely in a later session — the project's tier fixtures are elite-only now (see "Province Resource Tiles Moved to the Plan; Standard Scenario Removed" below); this entry is kept as history.
- **1 failure fixed — stale test expectation**: `cost-calculator.test.ts`'s `"calculateTotalCost returns scalarized building, mobilisation, and upkeep totals"` test asserted pre-triangular-upkeep values (`upkeep: 7.2`) that were never updated after `calculateTriangularUpkeepForConfig` (staggered per-unit upkeep — see Unit 2's Engine Changes) replaced the old flat-upkeep calculation in `225b151`. Hand-verified the triangular formula independently against the test's exact fixture inputs before trusting the code's output — the code was correct, only the test was stale. Updated to `upkeep: 77.23636363636363` / `total: 4187.236363636363`.
- **1 failure fixed — real scheduling bug**: `simulateUnitResearchTargets`'s JIT backward scheduler (`unit-research-sim.ts`) reported a **phantom research segment** for any task that couldn't fit before its deadline: the task was removed from the active scheduling set (`unscheduled`) but the final segment-mapping step still defaulted its missing start/end hours to `scenarioStartHour` instead of dropping it (`?? scenarioStartHour` fallback). This defeated `planMobilizationBuild`'s existing "retry with more cities" safety net (`unit-mobilization-plan.ts`), which only checked segment *existence* for a unit, not whether that segment was genuinely scheduled — so a genuinely infeasible 1-city SASF plan was silently accepted, with SASF L1 shown starting at scenario start hour 15, ~192 hours before its own ASF L4 prerequisite actually finished (hour 207). Fixed by filtering the final `segments` array to only tasks with a real `scheduledStarts` entry; the existing retry-with-more-cities loop (`tryScheduleGroups`) now works exactly as originally designed — no change needed there.

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
surfaced this session's India/Japan fixes. The Australia MAAV review happened
later the same day — see below — and surfaced a real, general bug rather than
an Australia-specific issue. Russia's commando province-mobilisation build is
still unreviewed.

## Captured-nation swap, Russia special_forces relocation, army_base
idle-upkeep fix (session, 2026-08-14, continued)

Three unrelated fixes to the PNTH V Iron plan, done later the same day as the
India/Japan dead-window session above.

### Mozambique → Iran swap

User direction: "swap Mozambique for Iran in the coalition plan" — reflects
the real game state of which AI nation is actually being captured. Iran
(`data/scenarios/elite/antarctica/countries/iran.yml`) is a single-city AI
nation, already correctly `status: occupied` hardcoded (matches the
single-city-AI-nation convention — see Unit 1's "Country YAML — `status`
Field" section), doctrine eastern, capital Tehran (components, pop 5).
`pnth-v-iron-2026-aug.yml`'s captured-nations block swapped `mozambique` →
`iran` (same shape: `status: occupied`, `capture_day: 2`, `demands: []`).
Updated: the PNTH roster table above, `README.md`'s `IRON_COUNTRIES` example
list, and `data/scenarios/elite/antarctica/coalition-plan.md`'s captured-nations
table/capture-timing notes/"Not Selected" list.

**Verified not a regression**: Iran's capital (Tehran) is a **components**
city, same resource as Mozambique's Maputo — so under the occupied-AI
heuristic (`OCCUPIED_AI_TARGET_BY_RESOURCE`, only supplies/electronics cities
get any improvement), Iran's eco build is `(no builds)`, identical treatment
to what Mozambique had. Confirmed via `iron-occupied-plan.ts` run.

Iran's province data was also updated with real (partial) in-game info: 1 of
its 10 total provinces has a **fuel** resource tile (previously an all-zero
placeholder split, `total` was already correct). Fuel isn't in
`OCCUPIED_PROVINCE_BUILD_ORDER` either (only supplies/electronics cohorts get
a build), so this new fuel province also correctly gets `(no builds)` — base
occupied-rate production only, confirmed via rerun.

### Norway: supplies cities excluded from the occupied-AI heuristic

User direction: "we need to rebuild norway so we are not annexing or making
any eco improvements in the supply cities." `OCCUPIED_AI_TARGET_BY_RESOURCE`
(`src/harness/smoke/iron-heuristic.ts`) dropped its `supplies: 5` entry,
leaving only `electronics: 5` — supplies cities now get the same "no
improvements at all" treatment as rares/components/fuel. Norway is currently
the **only** occupied country with a supplies-tile city (Bergen, Stavanger) —
Madagascar (rares), Solomon Islands (electronics), Iran (components) don't
have one — so this is architecturally a global heuristic change but only
actually affects Norway today. Verified: Bergen/Stavanger now show
`(no builds)`; Kristiansand (Norway's electronics city) unaffected, still
annexes + climbs `arms_industry` to L5.

### Russia's special_forces demand: Moscow/Saint Petersburg → Samara

User direction: "special forces should move from moscow to samara - so we get
the airport buff there." Investigation found the demand was actually
cost-driven-split 12/12 across Moscow (capital, components, already starts
`air_base: 1`) and Saint Petersburg (supplies — the coalition's **lowest**
`resource_priority` resource), not solely Moscow as the user's phrasing
suggested. `special_forces` L1 requires `army_base L3` + `air_base L1` +
`recruiting_office L1` — `air_base` is a hard eligibility gate, not a
production bonus; the "airport buff" the user meant is `air_base`'s
`production_bonus_pct`, which is wasted on Moscow (already has it) and Saint
Petersburg (low-priority resource). Samara is Russia's **electronics** city
(coalition's **highest**-priority resource per `resource_priority`), starts
`air_base: 0`, and was unused by any other demand — pinning special_forces
there turns the eligibility requirement into real eco investment, the same
rationale already used for Japan/India's SASF `preferred_cities` pinning.

Fix: `pnth-v-iron-2026-aug.yml`'s Russia `special_forces` demand gained
`preferred_cities: [samara]` — no engine changes needed, reuses the existing
`preferred_cities` pinning mechanism (`joint-city-optimizer.ts`'s
`foldInDemands` pre-pass). Verified: all 24 special_forces now mobilise in
Samara alone (RO auto-sized to L3), with real `air_base L1` + `army_base
L1→L3` builds; Moscow/Saint Petersburg reverted to the normal cost-driven
fold-in and picked up `mobile_sam_launcher` instead.

### army_base idle-upkeep bug (found via the Australia MAAV review)

Investigating "the army bases in some cities start v early so are wasting rss
on maintenance while they stand idle - specifically the maav cities"
(Australia) surfaced a **general bug**, not Australia-specific — confirmed
identical in Italy/South Africa/Pakistan/New Zealand's MRL/MAAV cities too.
`army_base` genuinely has a `daily_upkeep.cash` field at every level
(`data/buildings.yml`, L1=100/day rising to L4=130) — a built-but-unused
army_base really does burn cash for nothing.

**Root cause**: Unit 2's own engine (`computeCountryForceProjection` /
`buildCityInfraStepsFromEco`, `country-force-projection.ts`) already schedules
a city's full infra chain — including `army_base` — to finish exactly when
mobilisation starts (confirmed zero-gap against `iron-fp-<country>.html`,
Unit 2's raw output). But `iron-bp-plan.ts`'s own integration step
unconditionally re-chained every non-RO/AI infra step "back-to-back starting
from `backfillEndAbsHour`" (right after the RO2 backfill, ~day 3–9) whenever a
city got an RO2+ backfill — dragging `army_base` 7–14 days earlier than Unit
2 originally placed it. This re-chaining logic was written for **genuine
dead-window cities** (Japan/India's SASF cities sharing a queue with a filler
like AWACS/UAV/warhead, from the India/Japan session above), where finishing
the chain earlier genuinely helps by making the filler mobilisation-eligible
sooner. It fired identically for **ordinary single-unit-queue cities**
(every MRL/MAAV ground-build city), where there's no filler to benefit and the
early completion was pure waste.

**Fix**: `isDeadWindowSlot` (`country-force-projection.ts`, previously a
private helper) is now exported. `iron-bp-plan.ts`'s `otherSteps` computation
only applies the early re-chain when the city is a genuine dead-window slot
(`isDeadWindowSlot(slot.mobQueue, catalog, buildings)`) or has deferred RO3+
hops still needing placement (`deferredRoHops.length > 0` — an edge case no
current city hits, kept to avoid an untested code path). Otherwise `otherSteps`
stays exactly as Unit 2 computed it — already correctly JIT.

**Verified**:
- Australia's 3 MAAV cities (Adelaide/Gold Coast/Sydney): `army_base` now
  finishes 1 hour before mobilisation starts, not up to 14 days early.
- Italy's Rome (MRL) shows the same fix (army_base L4 completes ~1.3 days
  before mob start — the residual gap is the chain's own build duration, not
  slack).
- Japan's and India's `iron-bp-<country>.html` output is **byte-identical**
  before/after the fix (diffed directly) — confirms the dead-window cities
  this logic was originally written for are completely unaffected.
- `npm test`: only the 5 pre-existing baseline failures (naval/seasonal empty
  catalogs), no new failures.

Rebuilt: italy, south_africa, pakistan, new_zealand, australia, russia
(eco/fp/bp), plus the 12-country coalition aggregate.

## Two New Elite Units — Helicopter Gunship + Elite Attack Helicopter (session, 2026-08-14, continued)

Added from real screenshot data (eastern doctrine only): `helicopter_gunship`
(`helicopter_units.yml`, 6 levels, requires `air_base level 1` +
`arms_industry level 1`) and `elite_attack_helicopter`
(`seasonal_units.yml`, 3 levels, requires `air_base L3/4/5` +
`secret_weapons_lab L1` + `arms_industry L1`). See the "Elite Unit Catalog
Status" table for full detail.

**Design question surfaced and resolved**: `elite_attack_helicopter`'s real
in-game research prerequisite is "Any Helicopter (Tier N)" — an OR across
three independent unit trees (`helicopter_gunship`, `attack_helicopter`,
`asw_helicopter`). Traced all five places `requirements` strings get parsed
(`unit-research-sim.ts`, `unit-mobilization-plan.ts`, `flip-point-solver.ts`,
`joint-city-optimizer.ts`, `country-force-projection.ts`) and confirmed: every
element of the array is parsed independently and accumulated as a mandatory
AND (`Math.max(existing, parsed)` into a dependency map) — there is no OR/
alternative syntax anywhere in the schema or engine, and an unparseable string
is silently dropped with no warning. Per user direction, resolved by anchoring
to `helicopter_gunship` specifically (the eastern-doctrine unit actually in
play this session) rather than inventing unsupported syntax or silently
dropping the gate: `elite_attack_helicopter` level 1/2/3 requires
`helicopter_gunship` level 1/4/6 respectively, confirmed level-by-level by the
user. If a future session needs true OR-across-units support (e.g. a western
or european country using `attack_helicopter`/`asw_helicopter` as its base
instead), that requires a schema/engine change — not present today.

`npm test`: only the 5 pre-existing baseline failures (naval/seasonal empty
standard-tier catalogs — see "Test Suite — Pre-existing Failures" above), no
new failures.

## Japan — 10 Elite Attack Helicopter Added (session, 2026-08-15)

Added a demand of **10 `elite_attack_helicopter` (EAH), needing to reach
research level 3**, to Japan's PNTH V Iron plan (originally scoped as 15
across all three `unit_limit` tranches, reduced to 10 during planning once the
real mob-queue/infra cost was worked out — see below).

**Western doctrine placeholders added** (same convention as
`mobile_sam_launcher`/`fixed_wing_veteran`): both `elite_attack_helicopter`
and its prerequisite `helicopter_gunship` (`data/scenarios/elite/units/`) were
eastern-only; Japan is western. Both gained a `western` block at every level,
copied verbatim from `eastern`, unconfirmed pending real screenshots. EAH also
gained its real `unit_limit` mobilisation cap (5/10/15 at levels 1/2/3,
matching `elite_frigate`'s existing pattern) on both doctrines' mobilisation
blocks.

**Why 10 units only needs air_base L4 on paper, and only L3 in the real
pipeline**: building-type requirements (`air_base level N`) are checked
strictly per-city, never pooled across a country (verified by tracing
`country-force-projection.ts`/`joint-city-optimizer.ts` — every `CityMobSlot`
builds its own independent chain); unit-type prerequisites
(`helicopter_gunship level N`) are resolved country-wide via the 2 shared
research slots, no building dependency. A 10-unit demand fully resolves within
the `unit_limit` 5+5 tranche (levels 1-2) — the level-3 tranche (the only one
gated on `air_base level 5`) is never generated, so the units still reach
level 3 for free via the standard auto-upgrade mechanic without ever needing
L5 built anywhere. In practice, the real running pipeline
(`country-force-projection.ts`'s `getUnitBuildingRequirements`) hardcodes
`unit.levels["1"]`'s requirements for city-infra sizing regardless of target
level — so the dedicated city only actually built air_base to **L3** (EAH's
own level-1 floor), even leaner than the L4 hand-estimate made during
planning.

**Doesn't fit the existing SASF cities' dead-window capacity.** Checked
against the real `tmp/iron-bp-japan.html` (not a summary): Tokyo/Fujisawa/
Sendai's queues run essentially back-to-back with SASF from day ~17 to the
day-29h15 deadline; the only genuine idle gaps are ~1-81h depending on city, a
few times short of the ~230-270h a 10-unit EAH demand needs even at RO1. A
free optimisation was identified and **explicitly not taken, per user
direction, to avoid touching shared build-order logic**: building
`secret_weapons_lab` before (rather than after) `air_base L5` doesn't delay
SASF at all (both builds are needed regardless of order, and total sequential
time is fixed at 57h either way — confirmed by hour arithmetic, SASF's own
gate is identical, hour 388, in both orderings) but would let EAH become
eligible ~32h earlier per city; this would have recovered roughly 145h
combined across the three cities (~6 units' worth) — real but still short of
10, and left unbuilt as unnecessary complexity given a dedicated city works.

**Pinned to a new dedicated city: Yono** (rares) — the highest-priority
resource among Japan's four unpinned cities (Oita/fuel, Saitama/components,
Hiroshima/components, Yono/rares — electronics is already covered by Sendai),
matching the same resource-priority rationale already used for Tokyo/
Fujisawa/Sendai and Russia's Samara pin. Real verified output: RO L1 (as
hand-estimated — ample mobilisation-window slack made higher RO levels not
worth the extra build time), air_base L1→L3, secret_weapons_lab L1, all 10
units mobilised in one order at day 18h19 (gated by EAH's own level-1
*research* completing then, not by infra, which was ready a day earlier).

**A genuine, zero-margin risk found in the real output, not caught by hand
estimation**: EAH's level-3 research (needed for the "must reach level 3"
requirement, via auto-upgrade) completes at **exactly day 29h15 — the
deadline itself**, with no margin at all. Root cause: Slot 1 is fully packed
with SASF/AWACS/FWV research ahead of it, so EAH's own JIT-deferred research
chain (per the project's standard "level 2+ JIT to the deadline" strategy)
gets pushed as late as it can possibly go. Reported feasible, no infeasibility
flag — but worth watching if anything else in Japan's research queue shifts
later in a future change.

**Coalition-wide impact (iron pipeline, all 12 countries rebuilt)**: pooled
electronics net balance moved from +9,825 to essentially breakeven (−792).
More importantly, the **true hour-aligned pooled minima walk** (the number
that actually constrains the plan, not the naive per-country sum) now shows a
**genuine coalition-wide electronics shortfall of −5,639, first appearing at
day 28h19** — small and very late (right at the deadline), but real. Before
this addition, the iron pipeline had zero genuine insolvency points anywhere
in the 28-day window; this is the first one. Every other pooled resource
(supplies/components/fuel/rares/cash) stays comfortably positive throughout.
Not yet resolved — flagged for a future session (a modest electronics-side
adjustment elsewhere in the coalition, or accepting the shortfall).

`npm test`: only the 5 pre-existing baseline failures, no new failures.
Verified via the real pipeline (`iron-eco-plan` → `iron-fp-plan` →
`iron-bp-plan` for Japan, then `iron-resource-projection` rebuilt across all
12 countries) — not just the hand-derived estimates made during planning.

## Airport Demolish — Day-4 Consequence of Garrison Disband (session, 2026-08-15)

Disbanding the starting-garrison gunships (see "Starting Units — Garrison Mechanic"
above) also forces destruction of each homeland capital's original airport
(`air_base` level 1 — the building every capital starts with) on the same day, day 4.
Investigated and modeled in the **Iron Pipeline only** this session; the production
Unit 3 pipeline (`resource-projection.ts`) does not yet have this mechanic.

### Key finding — no build-chain timing impact anywhere

Traced `buildCityInfraSteps` (`src/engine/optimization/country-force-projection.ts`,
the formula-based "from scratch" chain builder behind `iron-fp-plan.ts`/
`iron-bp-plan.ts`'s `[infra]` steps): its level loop is hardcoded
`for (let lvl = 1; lvl <= targetLvl; lvl++)` — it **never consulted any city's real
starting building level, for any building, even before this session**. Confirmed
empirically pre-existing: New Delhi and Tokyo's `iron-bp-*.html` output already showed
`[infra] air base L1` as an explicit 24h build step starting day 10, despite both
cities' YAML having `starting.air_base: 1` all along. Consequence: **destroying the
airport changes zero military build-chain timing, flip points, or mob-queue starts** —
confirmed by diffing `iron-fp-<country>.html` byte-for-byte before/after for all 9
affected countries (identical in every case). New Delhi's SASF chain is not specially
exposed by this mechanic — India was already re-building air_base from scratch.

### Engine change — `forcedAirBaseDestructionAbsHour`

`simulateBuildOrder` (`src/engine/simulation/build-order-sim.ts`) gained an optional
`forcedAirBaseDestructionAbsHour?: Record<string, number>` (cityId → absolute hour).
Past that hour, air_base's `EconomicBuildingEffects` (production bonus) are zeroed for
that city while its level-tracking (`airBase.state`) is left untouched — models "the
building is destroyed" for income purposes only, without touching build-chain
eligibility (which never depended on the starting level anyway, per the finding
above). Absent/default ⇒ no behavior change; this is the shared primitive both the
Iron Pipeline and the production `city-eco-beam.ts` call, so the addition is inert for
every other caller.

Wired into all three Iron Pipeline scripts that call `simulateBuildOrder`
(`iron-eco-plan.ts`, `iron-bp-plan.ts`, `iron-occupied-plan.ts` — `iron-fp-plan.ts`
doesn't call it at all, consistent with the finding above) via a capital-only override,
**defaulting to day 4** (matching the gunship disband day), overridable per-run via
`IRON_AIRPORT_DESTROY_DAY=<day>` for what-if variants. Applies uniformly to all 12 PNTH
countries' capitals — a no-op for the 3 small captured AI nations (Madagascar, Solomon
Islands, Iran), whose capitals already start with `air_base: 0`. Norway (occupied,
capture day 4) is included too: capture-day zeroing already zeroes all of Oslo's
production before capture, so the destroy-day-vs-capture-day ordering is moot — verified
empirically, not just reasoned about.

### Coalition-wide result (all 12 countries, `IRON_COUNTRIES=<all 12>`)

Every capital's air_base sat flat at its starting level (1) for the entire eco-phase
window pre-fix (the iron heuristic's `AI_TARGET_BY_RESOURCE` never touches air_base at
all), continuously contributing a free +5% production bonus to that capital's own
resource (and cash) for as long as nothing else touched it — up to the full 28-day
window for capitals with no military air_base role. The day-4 demolish truncates this
free credit to just the first ~4 days. Per-capital loss (native resource / cash):
Canberra −1,955/−1,220, Rome −1,846/−1,215, Wellington −1,846/−1,215, Tokyo
−1,822/−1,206, Moscow −1,899/−1,303, Islamabad −2,194/−1,634, Cape Town −1,143/−1,536,
New Delhi −1,681/−1,206, Oslo −348/−261 (Oslo's is much smaller — see capture-day note
above).

Coalition pooled Net Balance deltas: supplies −7,469, components −1,899, fuel −2,542,
rares −1,143, electronics −1,681, cash −10,796. Every pooled resource except
electronics stays comfortably positive at its true hour-aligned minima (the number
that actually constrains the plan — see the Iron Pipeline's "Design Decision" above).
**Electronics is the one resource where this isn't free**: it was already the
coalition's sole negative pooled resource (from the Japan EAH addition, previous
session); the true minima deepens from −5,639 to −7,263, both at day 28 h19 — the
deadline crunch. New Delhi is the only affected capital producing electronics, so its
entire −1,681 loss lands on the one resource already in deficit.

**Resolution — no market-purchase mechanic built.** Per user direction, this deficit
is covered by the real in-game "starting offers" market (day-1 cash→electronics
conversion from starting balances, ~13k available — comfortably larger than the
~1.7–7.3k deficit). Confirmed no such mechanic exists anywhere in this codebase or
data (`buildings.yml`, `scenario.yml`, schemas all have no cross-resource conversion
concept) — deliberately not modeled, since it's resolved out-of-band by an existing
game mechanic rather than something the simulation needs to compute.

### Verification

`npm test`: only the 5 pre-existing baseline failures, no new failures. Full 12-country
`iron-eco`/`iron-fp`/`iron-bp`/`iron-occupied`/`iron-resource-projection` regenerated
with the new day-4 default and confirmed against a byte-identical `iron-fp-*.html`
diff (proves zero timing regression) plus the balance-sheet deltas above.

## Research Buffer + Japan Research ASAP Pins (branch `research_buffer`, session, 2026-08-15)

Two related features, both plan-level (not scenario-level), motivated by a real
observation in generated output: the JIT backward research scheduler packs level 2+
research with **zero margin** (e.g. Italy's `tmp/iron-bp-italy.html` showed
`tank_veteran L7` ending and `multiple_rocket_launcher L2` starting in the same slot
at the exact same hour) — unrealistic, since a player can "sleep in" and miss the
exact moment a slot frees up to requeue.

### Feature A — global research buffer

`research_buffer_hours` (new field on `coalitionForcePlanSchema`, set to `24` — 1 game
day — in `pnth-v-iron-2026-aug.yml`) reserves that many hours of idle slot time
immediately before every JIT-scheduled (level 2+) research task. Level 1 (always
ASAP) is never buffered. Implemented as a single-line change in
`unit-research-sim.ts`'s backward JIT loop: when a task is placed, the slot's
backward "free before" boundary (`slotFreeBefore[slot]`) ratchets to
`selectedStartHour - bufferHours` instead of `selectedStartHour` (unless the task is
level 1 or explicitly exempted — see Feature B), reserving genuine dead slot time
immediately preceding it. Threaded through `CountryForceProjectionInput.researchBufferHours`
→ `simulateUnitResearchTargets`'s new `bufferHours` opt, wired at all 4 harness call
sites that call `computeCountryForceProjection` (`iron-fp-plan.ts`, `iron-bp-plan.ts`,
`resource-projection.ts`, `force-projection.ts`) — both the Iron Pipeline and the
production pipeline pick it up uniformly since the field lives on the plan schema.

### Feature B — Japan research ASAP pins

Investigating Japan's research plan surfaced a second, related gap: `helicopter_gunship`
(a pure research-prerequisite anchor for `elite_attack_helicopter` — never itself
mobilised, so JIT-deferring it saves zero upkeep) was getting swept into the same
"push everything as late as possible" scheduler as every real demand, landing
`gunship L1` on day 17 of a 28-day truce despite having no reason to wait, and pushing
`elite_attack_helicopter L3`'s research to complete at literally the deadline hour
with zero margin. New `research_asap_pins` field (per-country, on `countryPlanSchema`)
hand-specifies unit levels to force ASAP instead of JIT-deferring — Japan's plan pins
`helicopter_gunship` L1-6, `elite_attack_helicopter` L1, `fixed_wing_veteran` L1,
`awacs` L1, and `air_superiority_fighter` L1. `computeAsapResearchCompletions`
(`unit-research-sim.ts`) computes each pinned level's earliest physically feasible
completion via a genuine multi-slot greedy forward walk (mirrors
`determineMaximumFeasibleLevel`'s pattern), then `country-force-projection.ts`
overwrites `latestCompletionByUnitLevel` for each pinned level with that value —
forcing the backward scheduler to place it ASAP — and builds a `noBufferTaskIds` set
(every pinned level ≥ 2) so Feature A's buffer never inserts artificial slack into a
chain that's supposed to pack tight (`helicopter_gunship` L2-6 have zero benefit from
spacing out, since deferring never-mobilised research saves nothing).

**A real bug found and fixed during verification, not just planning**: the first
version of `computeAsapResearchCompletions` computed completion hours as if research
slots were infinite (a simple topological walk ignoring slot capacity). With 5 pinned
chains all wanting to start near hour 15 but only 2 real slots, this produced
infeasible overrides for `awacs:1` and `air_superiority_fighter:1` — the scheduler
silently dropped both (failed `canFit`), while their already-scheduled higher levels
(`awacs` L2-L6, `air_superiority_fighter` L2-L4) survived as **dangling segments**
with no L1 underneath them, because the backward algorithm's drop-cascade only
un-schedules dependents still in the `unscheduled` set — anything already committed
stays committed. This is the "known pre-existing risk" flagged when Feature A was
designed (a lower level failing `canFit` after a dependent level 2+ task was already
scheduled), triggered here by Feature B's own override rather than the buffer. Fixed
by making `computeAsapResearchCompletions` genuinely slot-aware (tracks
`slotAvailableAt` per slot, greedy earliest-start-wins selection across all
currently-ready pinned tasks) — verified via direct `computeCountryForceProjection`
calls that all 6 of Japan's research-pinned units now produce a real segment, and via
a regression test in `country-force-projection.test.ts` asserting every pinned
`unit:level` is present in the output.

**Verified schedule shape (real Japan output, `pnth-v-iron-2026-aug`)**: with only 2
slots, `air_superiority_fighter L1` (15-16h), `awacs L1` (15-37h, other slot),
`fixed_wing_veteran L1` (16-22h), and `helicopter_gunship L1` (22-41h) queue up as
tightly as physically possible rather than all landing at literally the same instant
(impossible with 2 slots for 4 chains) — gunship's own L2-L6 chain then runs back to
back with zero buffer (any gap present is a real unlock-day gate, not the buffer;
confirmed by re-running with `researchBufferHours` omitted and asserting identical
gunship timing). Every unpinned level ≥ 2 transition (`awacs` L2+, `fixed_wing_veteran`
L2+, `air_superiority_fighter` L2/L4, `elite_attack_helicopter` L2/L3) shows exactly
or more than the 24h buffer wherever it's the binding constraint in a densely packed
slot near the deadline.

### A second bug — no margin between the last research task and the truce deadline itself

User caught this directly by reading `iron-bp-japan.html`/`iron-bp-italy.html`:
`elite_attack_helicopter L3`, `awacs L6` (Japan), and both slots' terminal levels in
Italy's MRL/MAAV/tank_veteran chain all completed at *exactly* the deadline hour
(day 29 h15) — zero margin, "not one game day before true ends." Root cause: the
buffer only ratchets `slotFreeBefore[slot]` *after* a task is placed, protecting the
gap **before** the next (chronologically earlier) task — but the very first task
considered in a slot's backward walk (the one that ends up **last** chronologically)
has nothing bounding its own completion except the raw `deadlineAbsoluteHour`, which
the buffer never touched. Fixed in `unit-research-sim.ts`: `successorStartBound` now
also gets `Math.min(..., deadlineAbsoluteHour - bufferHours)` for any task that is
neither level 1 nor in `noBufferTaskIds` — symmetric with every other buffered
handoff. Verified: Italy's and Japan's terminal research segments (`mobile_anti_air_vehicle L7`
in slot1, `multiple_rocket_launcher L5` in slot2 for Italy; `elite_attack_helicopter L3`,
`awacs L6` for Japan) now complete at day 28 h15 — exactly 24h before the day 29 h15
deadline — regenerated and confirmed in both `iron-bp-<country>.html` files, not just
inferred. Regression tests unaffected (31/31 still pass).

### `unit_limit` mobilisation tranches — flagged here, since fixed ✅

Reviewing Japan's regenerated output, the user also caught that `elite_attack_helicopter`'s
mobilisation queue shows a single `[mob] elite attack helicopter ×10` batch (Yono,
day 18 h19) — all 10 units mobilised at once, when EAH has a real `unit_limit` cap of
5/10/15 at research levels 1/2/3 (see "Elite Unit Catalog Status"). In-game, only 5
units can exist while research sits at level 1; the remaining 5 shouldn't be
mobiliseable until level 2 research actually completes (day 26 h08 in this run) —
the current model ignores this entirely for a batch this size. Confirmed via grep:
`unit_limit` is parsed by the schema and consumed by the older, separate
`unit-mobilization-plan.ts` engine (`force-build-plan.ts`'s single-country plan
family), but **never referenced** in `country-force-projection.ts` or
`joint-city-optimizer.ts` — the actual engine this Iron Pipeline / PNTH plan runs on.
This is a real, pre-existing gap, unrelated to and not caused by the research-buffer
work in this session — confirmed out of scope per explicit user direction ("your
scope is solely to change the research"). Flagged here for a future session: the
mobilisation queue for any `unit_limit`-capped demand needs to split into
level-gated tranches (batch N only starts once the research level that raises the
cap past the previous batch's size has completed), not treated as one monolithic
mobilisation step.

**Fixed** in the "`unit_limit` Tranches for City-Mobilised Units + Australia
Reassignment" session below — both the province-mobilised case (`commando`) and
this exact city-mobilised case (`elite_attack_helicopter`) now split into real
research-gated tranches. See that section for the full implementation and the
two further real bugs (`getUnitBuildingRequirements` hardcoded to level 1;
`evaluateAbsorptionOptions`'s dead-window capacity inverted for a large
candidate/small primary) it surfaced along the way.

### Future work (documented, not built this session)

Research whose unit has **zero mobilisation demand** in the plan (a pure prerequisite
anchor, like `helicopter_gunship` here) has no upkeep benefit from JIT deferral —
deferral only pays off when it delays a *mobilised* unit's upkeep clock. A future
programmatic retrofit could auto-detect `demandCount === 0` units pulled in only via
`expandTargetsWithUnitRequirements` and schedule them ASAP automatically, replacing
the need for hand-specified `research_asap_pins` entries like Japan's. Deliberately
not built now, per explicit user direction — Feature B is the hand-cranked stand-in,
kept simple and manually verifiable in the same spirit as the rest of the Iron
Pipeline's hand-specified pinning (`preferred_cities`, `min_ro`).

### Downstream impact — coalition regenerated, real cost increase confirmed

Both features shift research (and therefore mobilisation-readiness) timing for every
country whose plan is re-run with `research_buffer_hours` set — which is now every
country in `pnth-v-iron-2026-aug.yml`, since the field is plan-wide. Full 12-country
`iron-fp`/`iron-bp`/`iron-occupied`/`iron-resource-projection` regeneration confirms
this changes upkeep costs coalition-wide (per `npm run smoke:iron-resource-projection`,
`IRON_COUNTRIES=` all 12; `iron-eco-plan` deliberately **not** rerun — it has no
dependency on research scheduling at all, since eco/build plans are driven purely by
the fixed heuristic in `iron-heuristic.ts`, not `computeCountryForceProjection`).

Coalition Balance Sheet (pooled), after both the buffer and the deadline-margin fix:

```
                  supplies    components    fuel        rares     electronics   cash
Eco income       1,086,268     721,962    398,077     267,800     442,604    3,302,843
+ Starting bal     285,984     214,480    107,248      77,747      77,747    1,072,496
= Gross avail    1,372,252     936,442    505,325     345,547     520,351    4,375,339
− Infra cost       275,050     238,600    262,800      55,050     162,025    1,402,225
− Mob cost         741,950     642,650     31,000      84,600     316,100    1,601,500
− Upkeep cost      308,959      11,224    231,962           0      50,516      708,209
= Net balance       46,293      43,968    -20,437     205,897      -8,290      663,405
```

True hour-aligned pooled minima: supplies +53,609, components +33,472, **fuel
−19,203** (day 29 h14, first negative day 29 h00), rares +57,207, **electronics
−10,691** (day 28 h19, first negative day 28 h15), cash +652,466.

Both deficits are worse than the pre-deadline-margin-fix baseline (fuel especially —
minima deepened from −3,670 to −19,203, roughly 5×; electronics from −9,881 to
−10,691) — driven by upkeep costs rising across every resource (e.g. fuel upkeep
216,653 → 231,962), since pulling research earlier to leave deadline margin also
pulls unit auto-upgrades earlier, extending the window units pay upkeep at higher
tiers. **Not a blocker per user direction**: both deficits are resolvable out-of-band
via real in-game mechanics (investing in fuel/electronics provinces, buying the
resource on the market) — same resolution already used for the pre-existing
electronics shortfall (see "Airport Demolish" session above). No engine change or
further eco-side investment made to close them.

### Verification

`npm test`: only the 5 pre-existing baseline failures, no new failures. New tests:
4 in `unit-research-sim.test.ts` (buffer invariant, no-buffer regression, level-1
independence, `noBufferTaskIds` exemption) + 2 in `country-force-projection.test.ts`
(Italy buffer invariant end-to-end, Japan pin correctness + dangling-segment
regression guard). Italy and Japan's `tmp/iron-bp-<country>.html` regenerated and
spot-checked directly (not just the unit tests) for the gap/pin shapes described
above.

## Electronics Market Liquidity Check — Real Data, Not Just Assumption (session, 2026-08-16)

Every prior session that surfaced a coalition-wide electronics shortfall (Airport
Demolish, Research Buffer — both above) resolved it by asserting the in-game
cash→resource stock market would cover it, without ever checking real market data.
This session validated that assumption directly: the user screenshotted the Buy
Electronics tab of the Stock Market from 5 identified PNTH players (India, Russia,
Pakistan, Japan, South Africa) plus 3 additional snapshots the user judged immaterial
to attribute to a specific player, and compared the cash-priced offers (excluding
each market's `+4,000 @ 0.625` line, which is gold/premium-currency priced, not cash)
against the documented shortfall and the coalition's cash position.

**Result**: 18,375 electronics available for ~208,098 cash across the 8 snapshots
checked (~2,300 units/snapshot average, holding consistently across every player
checked, at 9–14 cash/unit) — comfortably covers every version of the documented
shortfall (roughly −5,600 to −10,700 depending on session). Checked against the
coalition's cash position too: the Research Buffer session's Coalition Balance Sheet
shows a cash net balance of +663,405 and a true hour-aligned pooled minima of
+652,466 (the worst point anywhere in the 28-day window) — the ~208k cash cost is
well under a third of that floor, so funding the purchase doesn't threaten cash
solvency at any point in the timeline.

**Where this lives**: full per-player breakdown table is in
`data/scenarios/elite/antarctica/coalition-plan.md`'s new "Electronics Market
Liquidity Check" section (not duplicated here — that doc is the canonical home for
coalition roster/economics notes). This closes out the electronics-shortfall open
item as resolvable via market purchase with real supporting data, not just an
asserted mechanic — no engine change made or needed, consistent with every prior
session's direction that this is deliberately out-of-band.

## Plan-vs-Actual Tracking — `iron-daily-balance.ts` (session, 2026-08-16)

New tool for checking the PNTH V Iron plan against real in-game screenshots as the
build progresses, rather than only trusting the projection in isolation.

### What Was Built

`src/harness/smoke/iron-daily-balance.ts` (`npm run smoke:iron-daily-balance`) —
parses the already-generated `tmp/iron-bp-<country>.html` (same "parse, don't
recompute" precedent as `iron-resource-projection.ts`; no engine recomputation, no
duplicated cost/income logic, zero risk of drifting from that file's own — frequently
bugfixed — accounting). Reconstructs a real running balance by prefix-summing the
embedded `iron-hourly-net-flow` JSON array from the "Starting Balance" row.

- **`IRON_COUNTRY=<id>`** → `tmp/iron-db-<id>.html`, one row per day (all 7
  resources), rate = day-over-day average (avoids spiky single-hour artifacts from
  lumpy one-off build/mob costs).
- **`IRON_COUNTRIES=<id1,id2,...>`** → `tmp/iron-db-coalition.html`, hour-aligned
  pooled daily balance (6 `POOLED_RESOURCES`, same hour-aligned-sum approach
  `iron-resource-projection.ts` uses for its pooled minima) + a separate per-country
  manpower table (never pooled).
- **`IRON_AT_DAY=<n> IRON_AT_TIME=HH:MM`** (either mode, added mid-session once daily
  sampling proved too coarse for exact screenshot timestamps): exact-hour snapshot,
  fractional-hour interpolated, printed to stdout as well as embedded in the HTML —
  the single-command way to check a screenshot taken at an arbitrary time, not just a
  day boundary.

### Screenshot Comparison Methodology (established this session)

Real screenshots were checked against the projection for Italy, Australia, Japan,
South Africa, and India at various Day 4–5 timestamps. Key findings, now the standard
way to read a plan-vs-actual gap:

- **Manpower is the most reliable signal.** It tracked almost exactly on every
  country checked — it's the resource least likely to be spent on anything the model
  doesn't track, so a manpower mismatch would be the strongest sign of a genuine
  eco/build bug. None found.
- **Cash, rares, and supplies routinely run lower in the real game than projected —
  expected, not a bug.** Research costs are not part of `iron-bp-plan.ts`'s cost
  model anywhere (`InfrastructureCost + MobilisationCost + UpkeepCost` only, no
  research term — see the Objective Function sections above), and those three
  resources are the ones most commonly listed in unit research-cost blocks. Bringing
  L1 research forward (already the project's own standard ASAP strategy) or any other
  research spend will always show up as a lower real balance the model can't see —
  not a planning error, as long as it doesn't starve a resource the eco/build queue
  needs at the same time.
- **Electronics is not typically a research-cost resource** — a large electronics gap
  (as opposed to the modest ~20-30% gaps seen elsewhere, explainable by ordinary
  timing/build-order slack) is a real signal worth investigating, not research spend.
- **Icon identification, resolved after repeated mix-ups**: the in-game HUD's two
  middle resource icons are easy to transpose. Confirmed, consistent mapping: the
  **orange fuse/vial icon is rares**, the **green circuit-board icon is
  electronics** (order in the HUD: supplies, components, fuel, rares, electronics,
  manpower, cash).
- Manual, non-plan build decisions (e.g. an early/unplanned `army_base`) also show up
  as unexplained balance drift on whatever resources that building costs — same
  "check against what you actually did, not just the model" principle as research
  spend.

### Real Bug Found via This Tracking — Norway's Oslo/Drammen Credits Swapped

South Africa's screenshots showed a real, unexplained fuel/components gap even after
accounting for research spend and an early army_base. Root cause: the plan's
`city_credits` in `pnth-v-iron-2026-aug.yml` had Oslo (Norway's capital, fuel)
credited to `south_africa` and Drammen (components) credited to `italy` — but in the
actual game, Italy captured Oslo and South Africa got Drammen (the reverse). Fixed by
swapping the two entries to match reality; `tmp/iron-bp-italy.html`,
`tmp/iron-bp-south_africa.html`, and their corresponding `iron-db-*.html` daily
balance files were regenerated. Coalition-level totals are unaffected (a captured
city's income lands in the shared pool either way) — only the two countries' own
per-country balance sheets change.

### Output Archival Convention — `IRON_OUTPUT_DIR`

All six Iron Pipeline scripts (`iron-eco-plan.ts`, `iron-fp-plan.ts`,
`iron-bp-plan.ts`, `iron-occupied-plan.ts`, `iron-resource-projection.ts`,
`iron-daily-balance.ts`) now write/read directly under a shared output directory
instead of flat `tmp/`: `const outputDir = process.env.IRON_OUTPUT_DIR ??
"pnth-v-iron-aug26"`, with each script's existing subdirectory convention preserved —
`iron-bp-*`/`iron-occupied-plan.ts`'s bp output → `build-plans/`, `iron-fp-*` →
`force-projection/`, `iron-eco-*`/`iron-occupied-plan.ts`'s eco output → `eco-build/`,
`iron-db-*` → `daily-balances/`, `iron-resource-projection.html` at the directory
root. `iron-daily-balance.ts` and `iron-resource-projection.ts` read from
`tmp/<outputDir>/build-plans/iron-bp-<id>.html` accordingly, so the whole pipeline is
self-consistent under one directory without any manual file-moving. The unconstrained
Unit 1 beam's own output no longer writes files at all — `smoke:eco-plan` persists to
Postgres (see "Postgres Persistence" below), so the `IRON_OUTPUT_DIR` convention is
moot for it and the old `eco-beam/` manual-move workflow is retired. Existing
`tmp/eco-<id>.html` files from before that change are historical artefacts; nothing
regenerates them.

Per the user: `tmp/pnth-v-iron-aug26/` will be moved to Google Drive after the
current game ends, to serve as a baseline snapshot for evaluating strategic engine
changes in a future revision.

## Commando Research Scheduling + Province Mobilisation Tranches (session, 2026-08-16)

### Bug: commando's own research never appeared anywhere

User report: "why is commando research missing from russia's build plan?"
Root cause in `src/engine/optimization/country-force-projection.ts`:
`classifyDemands` correctly buckets `commando` (`mobilisation_source: province`)
into `provinceDemands`, separate from `activeDemands` (city-mobilised) and
`launcherDemands` (zero-mob-time platforms) — but the research-target setup that
feeds `simulateUnitResearchTargets` only looped over `activeDemands` and
`launcherDemands` (the latter added specifically to fix an earlier, identical bug
for launcher units — see the Iron/India/Japan sessions above). There was no
equivalent loop for `provinceDemands`, so commando's real research data
(`seasonal_units.yml`) was never scheduled at all — confirmed empty in the
generated HTML, commando only ever appeared in the province-mob summary line.
Separately, `planProvinceMobilization`
(`src/engine/simulation/province-mobilization-plan.ts`) started mobilising
immediately after `mercenary_outpost` finished building, with zero dependency on
the unit's own research having actually completed.

**Fix, per the user's explicit direction** ("research is not a city or province
demand — it should be driven by the required units in the coalition plan"): the
three separate per-classification research-scheduling loops were unified into one
loop over `[...activeDemands, ...launcherDemands, ...provinceDemands]`
(`missingDataDemands` still excluded) — research targets are now derived from
every real demand in the plan regardless of mobilisation-source classification,
closing this entire bug *class* rather than patching one more special case.
`planProvinceMobilization` gained a `mobilisationEarliestHourByLevel` floor
(derived from `combinedResearch.segments`, same pattern the city-mob-queue code
already used for L1) so mobilisation genuinely can't start before the unit's own
research completes.

### `unit_limit` tranches — first real implementation (province side)

Investigating further, the user pointed out this is "the same issue we have with
EAH" — `unit_limit` mobilisation-tranche caps (alive-count gated by research
level, e.g. 5/10/15 at levels 1/2/3) were a known, previously-flagged-but-
unimplemented gap (see the India/Japan Dead-Window session above). Checked:
commando had **no** `unit_limit` data at all (unlike `elite_attack_helicopter`/
`elite_frigate`) — a real data gap, not an intentional exemption. Added
`unit_limit: 5/10/15` to commando's L1/L2/L3 mobilisation blocks in
`seasonal_units.yml` (flat-format placeholder, same convention as
`mobile_sam_launcher`/`fixed_wing_veteran` elsewhere in the catalog) and, per the
user's explicit direction ("we need to mobilise 12 commandos — 5 at level 1, 5 at
level 2, 2 at level 3 — research needs to fall in time to do that"), built the
first real tranche-mobilisation implementation:

- `getUnitLimitLevels(unitId, catalog, doctrine)` and
  `computeMobilizationTranches(count, limitLevels)`
  (`province-mobilization-plan.ts`) — unit-agnostic, pure functions; split a
  total count into research-level-gated tranches (12 with limits 5/10/15 →
  `[{level:1,count:5},{level:2,count:5},{level:3,count:2}]`).
- `planProvinceMobilization` reworked to compute one `ProvinceMobilizationTrancheResult`
  per tranche — each with its own `mobStart`/`completionHour`, gated by that
  tranche's own research-level completion, and its own mobilisation cost/duration
  computed at **that tranche's own level's catalog data**, not always level 1.
  User's explicit design decision on this (asked directly, confirmed consistent
  with the later EAH work below): "by the time a later tranche is allowed to
  mobilise, that level's research has already completed, so a freshly mobilised
  unit comes out at the currently-unlocked tier" — not the "always mobilise at
  L1, auto-upgrade for free" convention used for *ordinary* (non-tranche-capped)
  units elsewhere in the engine, which only holds because ordinary mobilisation
  always happens before any higher level completes by construction.
- **`mercenary_outpost` (the province building tranches depend on) is now built
  JIT per tranche, not all at once from scenario start.** User: "the merc outpost
  needs to be finished in time to support the mobilisation — not start at the
  same time." Original code built the whole L1→L3 chain immediately (finishing
  by day 4-5) regardless of when each tranche actually needed it — wasteful in
  principle (`mercenary_outpost` has real `daily_upkeep`, cash 165/330/495 at
  L1/L2/L3) even though the engine doesn't currently charge building upkeep
  anywhere (confirmed: no building's `daily_upkeep` — army_base's, mercenary_outpost's,
  any — is tracked as an explicit cost line anywhere in this codebase; the
  established fix pattern, matching the earlier `army_base` idle-upkeep session,
  is timing-only, not adding new cost-tracking machinery). Fixed with the same
  `Math.max(earliestFeasible, neededByHour)` JIT formula used elsewhere: each
  outpost level now completes exactly at (or just before) its own tranche's
  research floor, deferred as late as the sequential build queue allows.
- **Rendering bug found in the same pass**: the JIT-timed outpost's Build Queue
  row displayed the level's *completion* hour, while every other Build
  Queue/Mobilisation Queue row in this codebase displays *start* hours — since
  completion now legitimately coincides with the tranche's own mobilisation
  start, this made the outpost look like it was starting (not finishing) at the
  same instant as mobilisation. Added `mercenaryOutpostStartHour` to
  `ProvinceMobilizationTrancheResult` and switched `iron-bp-plan.ts`'s render to
  use it — now correctly shows e.g. L3's 36h build starting well before (not at)
  its completion/mobilisation hour.
- Province rendering in `iron-bp-plan.ts` also reformatted from a nested
  `<ul>` bullet list to the same `<h3>` + Build Queue/Mobilisation Queue table
  pair every city section already uses (user: "province mobilisation should be
  in the same format as a city mobilisation section") — scoped to
  `iron-bp-plan.ts` only, per the user's explicit request; the other three
  renderers with the same bullet-list pattern were left untouched.

**Deliberately not fixed**: pinning commando's research ASAP via
`research_asap_pins` (to use idle slot time instead of the ~day-19 start the
unpinned priority-based scheduler currently produces) — attempted, but
surfaced a real, previously-undiscovered bug: `computeAsapResearchCompletions`
computes a pinned unit's ASAP deadline in isolation from real slot contention
with non-pinned demands, and when a cross-unit prerequisite (commando needs
`special_forces` level N at every level) is also pinned to make the isolated
walk self-consistent, the two walks still don't reconcile with the real backward
scheduler — the resulting infeasible override silently dropped **both units'**
research segments entirely (worse than the original bug). Reverted; commando's
research is feasible but back-loaded. Flagged in the plan YAML's comments for a
future session — needs a real fix to the backward scheduler's handling of
cross-unit dependencies under a tight ASAP override, not a config workaround.

## Research Scheduler Bugs — Cascading Drop + Duplicate Self-Reference (session, 2026-08-16)

User report: "mobile radar research is missing from australia's build plan."
Ruled out both bug classes already fixed this session (not a catalog data gap —
`mobile_radar` has complete western-doctrine data; not a classification bug —
`classifyDemands` correctly routes it to `activeDemands`). Root cause was two
independent, genuine bugs in the shared backward JIT scheduler
(`simulateUnitResearchTargets`, `src/engine/simulation/unit-research-sim.ts`) —
the core loop used by *every* research plan in both the Iron and production
pipelines, not something specific to this unit or country.

**Bug 1 — premature loop termination after a same-pass cascade.** The
`while (unscheduled.size > 0)` loop runs one full pass per iteration, committing
at most one task per pass and dropping any eligible-but-infeasible task it
encounters along the way (cascading: removed from its own dependency's
`successorIds`, which can make that dependency newly eligible *within the same
pass*). But the `for...of` over `unscheduled` has already visited (and skipped,
via the `allSuccessorsScheduled` guard) anything earlier in Set-insertion order —
so a same-pass unblocking was never re-checked, and the loop's termination
condition (`selectedTaskId === null` → `break`) didn't distinguish "nothing
selected this pass" from "nothing can ever be selected." Fixed: track
`anyDroppedThisPass`; when nothing is selected but something was dropped,
`continue` (a fresh full pass) instead of giving up — termination is still
guaranteed since `unscheduled.size` strictly shrinks on any such pass.

**Bug 2 — the actual root cause for `mobile_radar`: duplicate dependency
entries.** `mobile_radar` (and `commando`, from the fix above) explicitly lists
its own previous level as a requirement (e.g. `mobile_radar level 2` requires
`mobile_radar level 1`) — redundant with the scheduler's automatic same-unit
chaining (`if (level > 1) dependencyIds.push(unitId:level-1)`). This produced a
**duplicate** entry in the dependency graph; when a drop-cascade tried to
unblock a lower level, only one of the two duplicate references got removed,
leaving it permanently blocked even with Bug 1 fixed. Fixed at the source in
`requiredUnitLevelsForResearchLevel`: self-references (`parsed.id === unitId`)
are now filtered out, since same-unit chaining is already handled separately by
every one of this function's 4 call sites in the file.

Both fixes verified independently: Bug 1 alone was necessary but insufficient
(mobile_radar levels 1-6 still all silently dropped, confirmed via
`PLAN_DEBUG=true` tracing that duplicate `successorIds` entries were the reason);
both together restored `mobile_radar` levels 1-5 (level 6 genuinely doesn't fit
given real slot contention — correct, not a bug). Russia's `iron-bp-russia.html`
(which also has the self-reference pattern via `commando`) regenerated
byte-identical, confirming the fix only changes behaviour where it was actually
broken.

## `unit_limit` Tranches for City-Mobilised Units + Australia Reassignment (session, 2026-08-16)

### General engine support for city-mobilised `unit_limit` tranches

The province-side tranche implementation above only covers province-mobilised
units. The next request — "the last bug to fix was the EAH bug in Japan's build
plan" — was the already-documented, previously-deferred gap: `elite_attack_helicopter`
(EAH, `unit_limit` 5/10/15) mobilises in a single lump `×10` batch at Yono
regardless of research level, when only 5 should be alive until level 2
completes. **Verified this was a genuine bug, not a display nuance**: EAH level 2
research completed day 26h08 but the single 10-unit batch started day 18h19 — 181
hours before the research that's supposed to unlock units 6-10 existed.

Fix mirrors the province implementation, reusing the same
`getUnitLimitLevels`/`computeMobilizationTranches` helpers (already
unit-agnostic) in the city-mob-queue code path
(`country-force-projection.ts`'s per-city `mobSteps` construction, cost
aggregation, and stepped-upkeep loops — the non-dead-window branch only; EAH's
dedicated city has no filler sharing its queue, and extending tranche support to
the dead-window branch too is explicitly out of scope until a real demand needs
it). A new shared `computeUnitLimitTrancheTiming` helper avoids duplicating the
JIT-timing formula across the mob-step and upkeep loops. `CityForceProjectionSlot["mobSteps"]`
gained an optional `level` field (set only for tranche-split units) so all four
renderers can show which tranche a batch belongs to — the existing renderers
already iterated `mobSteps` generically, so multiple entries per unit needed
zero structural renderer changes, just a `${level ? \` L${level}\` : ""}` label
suffix. Every unit without real `unit_limit` data keeps the exact old single-
event behaviour (empty-array guard), confirmed via byte-identical regeneration
of every other country.

### Real bug found via this work: `getUnitBuildingRequirements` hardcoded level 1

Follow-up user report after the tranche fix shipped: "japan is missing an air
base 4 for eah level 2 which is broken." Root cause: `getUnitBuildingRequirements`
(`country-force-projection.ts`) always read `unit.levels["1"]`'s requirements for
sizing a city's infra chain — so Yono only ever built `air_base L3` (EAH level
1's requirement), never `air_base L4` (level 2's), even though the mobilisation
queue was correctly gating tranche 2 on level-2 research completing. The building
needed to *support* that tranche was simply never built. This is the same gap
flagged (but deemed harmless at the time, for a different, smaller demand) in
the Japan EAH session above. Fixed: `getUnitBuildingRequirements` gained an
optional `level` parameter (default 1, so every other caller is unaffected), and
the per-city infra-chain builder now computes the primary unit's actual highest
required tranche level (same `computeMobilizationTranches` call already used for
mob timing) and merges that level's requirements into the chain via the
existing `extraRequiredLevels` hook (`Math.max`-merged, so it can only raise a
requirement, never lower one). Yono's build queue now correctly includes
`air_base L4` before any tranche mobilises; the small delay to tranche 1 (~1.5
days, since the whole merged chain builds before *any* mobilisation opens, not
per-tranche) was accepted as the correct tradeoff for closing the "missing
requirement" bug, not treated as a separate optimisation target.

### Real engine bug found via the Australia reassignment: inverted dead-window capacity

The user separately questioned Canberra's role in Australia's plan: it hosted
`mobile_radar` (7 units, smallest demand) plus one absorbed MAAV, and flipped to
military at day 23h11 — the **latest** of any Australian city despite the
**smallest** workload. Investigated and confirmed this was mathematically
correct JIT scheduling (a smaller total workload legitimately produces a later
last-responsible-moment start under `firstMobStart = deadline − primaryTotalHours`),
not a bug — but the user judged it strategically unwise regardless, and (per the
user, explicitly deferred to a future session) flagged this as a symptom of a
deeper gap in the force-projection optimizer: it only minimises resource cost,
never accounts for time-to-availability of the fielded force.

**User's tactical redesign** (implemented this session, matching the Iron
Pipeline's existing hand-specified philosophy): move `mobile_radar` off
Canberra entirely, splitting it across the three `mechanized_infantry` cities
(Maitland/Brisbane/Perth) instead, mobilising before mechanized_infantry in each
shared queue; make Canberra a third dedicated `mobile_anti_air_vehicle` city (24
units) alongside two of Adelaide/Gold Coast/Sydney (23 each), fully vacating the
third. `infraCompatible` (`joint-city-optimizer.ts`) is directional and only
accepts this city-sharing pairing with `mobile_radar` as the pinned/primary unit
(its requirements are a superset of `mechanized_infantry`'s); confirmed real
Smith's-rule upkeep numbers place radar before mechanized_infantry in the shared
queue automatically, no extra ordering mechanism needed.

**Getting the exact 24/23/23 split required a real engine fix.**
`estimateRoLevelForFixedCityCount`'s pinned-city allocation loop
(`joint-city-optimizer.ts`) dumped the *entire* remainder on the last listed
city (`Math.ceil(n/numCities)` for all others) — for 70 across 3 cities, 24/24/22,
inconsistent with the fair round-robin split (`ci < n % numCities ? ceil : floor`)
the function's own upkeep-cost estimate a few lines above had *already* been
assuming. Fixed the final allocation to match — 70/3 → 24/23/23, 7/3 → 3/2/2 (also
retroactively improved Japan's and India's existing SASF splits from 12/12/10 to
12/11/11 as an intentional side effect of the same fix; confirmed via full
regeneration that nothing else in either country's plan moved).

**Then a second real bug**: explicitly pinning *both* `mobile_radar` and
`mechanized_infantry` to the same three cities (needed — leaving
`mechanized_infantry` unpinned let the cost-driven fold-in decide a single new
consolidated RO4 city was cheaper, completely defeating the sharing design) made
all 30 `mechanized_infantry` units vanish **silently**, with zero error, in
every generated output. Root cause, in `evaluateAbsorptionOptions`
(`joint-city-optimizer.ts`)'s `deadWindowCapN`: the dead-window absorption
formula assumes the *candidate* being merged in is a small/light filler relative
to a large, long-infra-chain primary (the SASF+AWACS/UAV shape it was built
for) — here the roles are inverted (30-unit candidate into a 7-unit primary
whose own short infra chain and small workload push its own JIT start very
late), so `availableWindow` computes to zero or a small-but-insufficient
positive value, and `deadWindowCapN` floors to 0 → hard rejection. Separately,
`foldInDemands`'s pinned pre-pass swallowed that zero-capacity result with no
fallback and no warning — marking the city "used" regardless of whether
anything was actually placed there. **Both fixed**: `deadWindowCapN` now falls
back to unrestricted (deferring to the ordinary shared-queue capacity math)
whenever there's no genuine early-idle window to model, rather than hard-
rejecting a candidate that should just queue normally; `foldInDemands` now
throws a clear, descriptive error instead of silently dropping a pinned demand
it can't place — matching this codebase's established "surface data/planning
gaps loudly" convention (e.g. the `⚠ MISSING DOCTRINE DATA` banner) rather than
letting a plan silently ship with units missing. Verified the fix is correctly
scoped: India's SASF+UAV double-pin (the only other double-pin case in the
active plan, and per investigation the same *latent* bug, just never triggered
since UAV happened to be small enough to fit) regenerated byte-identical, as did
Russia; only Australia's actual bug scenario changed.

Final Australia state, all verified end-to-end (`npm test` clean throughout —
only the 5 pre-existing baseline failures — plus byte-identical regeneration of
every other `preferred_cities`-using country after each fix): Maitland/Brisbane/
Perth each mobilise `mobile_radar` (3/2/2) before `mechanized_infantry` (10
each), flip points ~day 19-20 instead of the old day 23h11; Canberra hosts 24
MAAV with only `army_base L1` (the L2 requirement was radar's alone); Adelaide/
Gold Coast host 23 MAAV each; Sydney fully vacated (pure eco for the truce).

## Province Resource Tiles Moved to the Plan; Standard Scenario Removed (session, 2026-08-23)

### Province tiles are now a plan fact, not a country fact

User direction: province resource-tile *distribution* is randomised per playthrough
(confirmed by tracing `ProvinceResourceInputs` — country identity, population, and
doctrine are not inputs to province production at all; only `resource`, `provinceCount`,
morale, and building levels are), so it doesn't belong in the country YAML alongside the
stable `provinces.total` count. Moved to the coalition plan.

- `ProvinceSchema` (`country-schema.ts`) now parses only `{ total }` — a `looseObject`
  with a `superRefine` that **rejects** (not silently strips) any of the five legacy
  tile keys (`supplies`/`components`/`fuel`/`rares`/`electronics`) if still present,
  naming the offending keys and pointing at the plan. Chosen over silent stripping
  specifically because ~25 country YAMLs were being hand-edited in the same session —
  a rejected file surfaces immediately; a silently-stripped one would produce a
  quietly-wrong ranking with no signal.
- `countryPlanSchema` (`coalition-force-plan-schema.ts`) gained `province_tiles?:
  { supplies?, components?, fuel?, rares?, electronics? }` (all optional non-negative
  ints), alongside the existing per-country `status`/`capture_day`/`city_credits`.
- `buildProvinceCohortsFromCountry` (`province-cohorts.ts`) takes an optional second
  `tiles?: ProvinceTiles` argument. **Omitted ⇒ every province is treated as
  non-resource-producing** and a once-per-country `console.warn` fires naming the
  country — this is the "default" ranking (city yield + known tiles only, valid across
  any playthrough). Supplying the game's observed tiles produces the "bespoke" ranking
  for that specific game. Also validates `Σtiles ≤ total`, throwing a clear error
  otherwise (province count is a hard ceiling on the plan's own account of itself).
- Threaded through every real consumer as an optional opt (old call sites unaffected):
  `runProvinceEcoBeam`'s `opts.provinceTiles` (used by `eco-plan.ts`, sourced from
  `planCountry?.province_tiles`), `CountryResourceBalanceOptions.provinceTiles`
  (`country-resource-balance.ts`), and `OccupiedYieldArgs.provinceTiles`
  (`occupied-yield.ts`, consumed by both `iron-bp-plan.ts` and
  `iron-occupied-plan.ts`). `iron-eco-plan.ts` previously loaded no plan at all (its
  province cohorts came straight off the country YAML) — it now loads one
  (`IRON_PLAN`, same default as the other Iron scripts) purely to source
  `province_tiles`; nothing else about it became plan-dependent.
- `pnth-v-iron-2026-aug.yml` and the superseded `pnth_v_road_2026_jun.yml` both gained
  `province_tiles` per country, transcribed from the country YAMLs' real observed
  values before they were stripped (Italy: supplies/components/fuel/electronics all 1;
  full set in the plan files themselves). All 36 `elite/antarctica` country YAMLs had
  their tile keys removed; `chile.yml` had a pre-existing one-space indentation bug in
  its `provinces:` key (predates this session, unrelated) fixed along the way — it had
  been silently accepted before since Zod's old schema didn't care about YAML
  indentation, only the mis-indented parse itself was the actual YAML syntax error,
  surfaced once `validate:countries` was re-run.
- **Default vs. bespoke ranking, concretely**: a no-plan `ECO_COUNTRY=all` sweep now
  produces the country-yield-only "default" ranking (every `eco_province_cohort` row is
  `non_resource_provinces` — verified directly against a real run in the live DB, see
  below); passing `ECO_PLAN=pnth-v-iron-2026-aug` produces the "bespoke" ranking for
  that specific game's observed tiles. The two are expected to diverge and both are
  legitimate — they answer different questions ("what can any playthrough of this
  country do" vs. "what can this actual game's tile draw do").

### First real Postgres write, and a genuine schema bug it caught

The `hephaestus` database was created and migrated for real against the live
`furiosa-prod` RDS instance this session (`npm run db:create` / `db:migrate`, both
idempotent, both verified). The first real write (Solomon Islands, chosen as the
cheapest possible country — one city — specifically to validate the write path without
running an expensive sweep) failed immediately:
`invalid input syntax for type integer: "301.2352941176471"`.

Root cause: `sql/002_eco.sql`'s hour columns (`last_build_completion_abs_hour`,
`start_rel_hour`, `start_abs_hour`, `start_hour`) were typed `INTEGER`. Game hours are
fractional — build durations are morale-adjusted and computed in minutes
(`build-order-timeline.ts` derives `startRelHour` as `minutes / 60`), so values like
`301.2352941176471` are normal, not corrupt input. The old HTML sink had hidden this
indefinitely by only ever displaying hours through `Math.floor`. Fixed by retyping all
four columns `NUMERIC` (schema was minutes old with no real data yet, so fixed at
source rather than via a corrective migration). **Units 2/3 will hit the identical
issue** when they add their own hour-bearing tables (flip points, mobilisation
timestamps) — flagged in the schema doc comments directly.

Verified end-to-end against live data after the fix: `city_id` stored bare (`honiara`,
not `solomon_islands:honiara` — the documented join-key trap, holding in real data not
just the unit test); the `country` `resource_flow` row exactly equals its `city` +
`province_cohort` rows summed (cash 24,665 = 20,109 + 4,556); the fractional hour
(`301.2352941176471`) round-trips exactly.

### Standard scenario removed entirely

Per explicit user direction ("frankly obsolete and not the key aim of this"),
`data/scenarios/standard/` (units, `ww3/countries`, `ww3/plans`, `ww3/scenario.yml` —
30 files) was deleted via `git rm -rf`. The project's focus has been elite/Antarctica
for the whole of this rebuild (see the Modular Architecture section); standard-tier
data had no consumer left except test fixtures.

**Real dependency found and migrated first** (would otherwise have broken `npm test`
with ENOENT): 4 test files loaded real files from `data/scenarios/standard/units/*.yml`
and `standard/ww3`'s scenario/country data purely as stable, arbitrary fixture input for
testing scenario-agnostic engine logic (research scheduling, mobilisation planning, unit
catalog resolution) — not testing standard-tier gameplay content itself. Per the user's
explicit rule ("migrate only if not already covered in the elite test harness"), each
was individually triaged:

- `load-unit-catalog.test.ts` — one test (`resolveUnitCatalogDirForScenario` fallback
  for `standard/ww3`) was an exact duplicate of the `elite/ww3` case directly above it
  (the function has no tier-specific branching) — deleted, not migrated. The other two
  (catalog loads successfully; file-path resolution) were migrated to `elite/ww3`.
- `unit-mobilization-plan.test.ts` — its `loadMergedUnitCatalog()` helper pulled 5
  separate standard catalogs together but the one test using it only ever exercised
  `air_superiority_fighter`; replaced with the file's own already-elite
  `loadEliteFighterCatalog()`, and the now-dead helper deleted.
- `force-projection-optimizer.test.ts` — all 6 tests are structural/generic
  (`optimizeForceProjection`'s own engine, not this codebase's newer
  `country-force-projection.ts`/Unit 2 engine — has **zero callers anywhere else in the
  codebase**, flagged here as dead code worth a future removal pass, not touched this
  session since that's a separate decision from fixture migration). Migrated wholesale
  from `standard/ww3`+`germany` to `elite/antarctica`+`italy` (both have
  `mobile_anti_air_vehicle`/`tank_veteran`), since nothing else in the suite exercises
  this file's actual subject.
- `unit-research-sim.test.ts` — the deepest migration: several tests already used
  `elite/units/*.yml` (added in later sessions for stealth-ASF prerequisite-chain
  coverage), but ~14 references still loaded standard `fighter_units.yml`/
  `infantry_units.yml`. Most assertions are structural (gap ≥ buffer hours, ordering,
  `deepEqual` between two runs) and needed only a path swap. Three tests assert **exact**
  exact hour/cost values tied to the specific catalog's real unlock days and durations
  (chained-level scheduling: L2 end/duration; unlock-day-through-offset shift for
  `special_forces` L5) — these were **not hand-derived**, but captured by directly
  invoking `simulateUnitResearchQueue` against the real elite catalog data and reading
  off the actual output (a lightweight, deterministic scheduling calculation over one
  unit — not a beam search, so within the "no expensive beam runs" boundary) — then
  sanity-checked against the raw YAML unlock days/durations before trusting them. One
  hand-derivation attempt (predicting `special_forces` L2's start hour from the unlock-day
  formula) was wrong and discarded in favour of the captured real value — `L2` does
  **not** wait for `L1`'s own completion in `simulateUnitResearchQueue` (only the
  unlock-day gate and slot availability apply), which running the code surfaced
  immediately and hand-derivation had silently assumed otherwise.
- `country-resource-balance.test.ts` and `province-cohorts.test.ts` — not
  standard-scenario dependent, but broken by the `province_tiles` schema change itself
  (fixtures built a `Country` object with the now-removed inline tile fields). Updated
  to pass tiles via the new `provinceTiles` opt instead; one new test added
  (`province-cohorts.test.ts`) asserting the omitted-tiles/all-non-resource default
  explicitly, and one asserting the `Σtiles > total` rejection.

Two cosmetic-only references left outside the test suite were also fixed: `run-force-plan.ts`'s
usage-example strings (now point at `pnth-v-iron-2026-aug`), and
`ww3-2026-remaining-occupied-economy.ts`'s default `WROE_SCENARIO` (now `elite/antarctica`
— this is a standalone, never-tested harness from the project's earlier WW3-focused
period, not wired to any `npm run` script; the country id it loads is already derived
from the scenario rather than hardcoded, so no other change was needed there).

**Verified**: `npm test` — 193 pass, 0 fail throughout (184 baseline this session → 194
after the province-cohorts test additions → 193 after the one genuinely-redundant test
was deleted). `npm run validate:countries -- elite/antarctica` /  `elite/ww3` clean.
`data/scenarios/standard` confirmed absent from disk and from every code/doc reference
in `src/`.

### A restore-then-redo detour, for the record

Mid-session, `data/scenarios/standard` was found deleted from the worktree with no
corresponding instruction yet given — treated as accidental (matching this project's
"investigate unfamiliar state before deleting/overwriting" convention) and restored via
`git checkout` before the user clarified it was their own deliberate action, taken
directly against worktree files. Redone properly once confirmed, with the real test
dependency this surfaced (above) migrated first rather than skipped.
