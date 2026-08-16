# Elite Antarctica — Coalition Plan

## Active Players (8v8)

| Country | Doctrine | Role |
|---|---|---|
| Italy | European | Mainland-forced |
| Japan | Western | Mainland-forced |
| Russia | Eastern | Mainland-forced |
| South Africa | European | Mainland-forced |
| Pakistan | Western | Mainland-forced |
| India | Eastern | Mainland-forced — highest electronics output of any candidate (63,197) |
| Australia | Western | Chosen — #2 of remaining candidates on supplies+electronics (217,177) |
| New Zealand | European | Chosen — #1 of remaining candidates on supplies+electronics (218,987) |

Doctrine mix: 3 European (Italy, South Africa, New Zealand) · 3 Western (Japan, Pakistan, Australia) · 2 Eastern (Russia, India).

## Captured Nations (4)

| Country | Cities | Capital resource | Population | Notes |
|---|---|---|---|---|
| Norway | 7 (multi-city) | Fuel | 6 | Evaluated as active candidate (202,588 supplies+electronics, 3rd of remaining 6) but taken as a captured territory instead of an active slot |
| Madagascar | 1 (AI nation) | Rares | 4 | |
| Solomon Islands | 1 (AI nation) | Electronics | 4 | |
| Iran | 1 (AI nation) | Components | 5 | Swapped in for Mozambique (2026-08-14) |

## Not Selected

**Evaluated as multi-city active candidates, not picked for an active slot or capture** — United Kingdom, Indonesia, Ukraine (see ranking below).

**Small AI nations, not in coalition**: Mozambique, Ivory Coast, Oman.

## Strategic Rationale

**Selection method**: real computed economic output (unconstrained city + province eco beam search over the full 28-day truce window, `npm run smoke:eco-plan` — Unit 1), not the population/resource-tier heuristics ("pop 6 supply capital", etc.) the previous version of this doc used. Ranked on this doc's own stated priority resources: **supplies + electronics**.

**6 of 8 slots are mainland-forced** (Italy, Japan, Russia, South Africa, Pakistan, India) — a hard constraint, not an economic pick, though all 6 still rank respectably (5th–9th of the 12 candidates evaluated).

**Remaining 2 slots** were chosen from the 6 leftover multi-city candidates, ranked by supplies+electronics over the truce window:

| Rank | Country | Doctrine | Supplies+Electronics |
|---|---|---|---|
| 1 | New Zealand | European | 218,987 |
| 2 | Australia | Western | 217,177 |
| 3 | Norway | Western | 202,588 |
| 4 | United Kingdom | European | 197,858 |
| 5 | Indonesia* | European | 197,398* |
| 6 | Ukraine | Eastern | 192,100 |

New Zealand and Australia were the clear top 2 and were chosen.

*Indonesia's number is understated: unlike the other 11 candidates, its province resource-tile breakdown hasn't been supplied yet, so it's missing the electronics contribution its identical-profile peer India gets from India's own electronics-tile province (+8,431 electronics / +2,631 cash over the 28-day window, confirmed by direct comparison — Jakarta and New Delhi are otherwise identical: pop 6, electronics resource, air_base 1, naval_base 1). Indonesia's true rank is likely higher; revisit if it's reconsidered for a future slot.

**No navy** — coalition is air-force focused; naval build is not planned for this scenario.

## Starting Garrison, Suicide Plan, and Capture Timing

**Every homeland country starts with a fixed garrison** (scenario-wide fact, now
recorded in `data/scenarios/elite/antarctica/scenario.yml`'s `starting_units`):
14 Motorized Infantry, 1 Gunship, 1 Mobile Radar — all level 1.

**Plan decision: all garrison units are disbanded on day 4** — with one exception:
**Australia keeps its starting Mobile Radar** rather than suiciding it, since
Australia's 8-radar target folds it in (only 7 more need mobilising instead of 8). All
other homeland countries' garrisons (including their own mobile_radar) are disbanded
on day 4 as normal.

**Capture timing for this plan's 4 captured nations**: Norway by day 4; Madagascar,
Solomon Islands, and Iran by day 2.

**Daily upkeep per homeland country, before the day-4 disband** (14×Motorized Infantry
+ 1×Mobile Radar + 1×Gunship):

| Resource | Motorized Infantry ×14 | Mobile Radar ×1 | Gunship ×1 | **Total/country/day** |
|---|---|---|---|---|
| Supplies | 560 | 20 | 0 | **580** |
| Fuel | 210 | 15 | 25 | **250** |
| Electronics | 0 | 0 | 25 | **25** |
| Cash | 840 | 40 | 80 | **960** |
| Manpower | 210 | 15 | 25 | **250** |

Across all 8 homeland countries: **4,640 cash/day**, plus proportional
supplies/fuel/electronics/manpower, for the ~4 days before disbanding.

**Two placeholder assumptions, flagged as unverified:**
- Motorized Infantry's cost data only exists for Western doctrine in the unit catalog
  (`data/scenarios/elite/units/infantry_units.yml`) — European and Eastern countries
  (5 of our 8) use the Western figures as a stand-in.
- Gunship's Western upkeep is unconfirmed — no screenshot yet. It's borrowed from the
  eastern/european values, which are confirmed identical to each other
  (`manpower: 25, fuel: 25, electronics: 25, cash: 80`).

**Known engine gap**: the eco-plan and coalition-force-plan harnesses currently
hardcode a day-4 capture delay for every occupied country. That's only correct for
Norway here — Madagascar/Solomon Islands/Iran need day 2. Making capture day
configurable per-country is real engine work, not yet done.

## Electronics Market Liquidity Check

The Iron Pipeline resource projections show a small coalition-wide electronics
shortfall late in the truce window (roughly −5,600 to −10,700 depending on session —
see CLAUDE.md's "Airport Demolish" / "Research Buffer" sessions), flagged as
resolvable via the in-game cash→resource stock market rather than an engine change,
but never previously checked against real market data.

**Spot-check (2026-08-16), cash-priced BUY ELECTRONICS offers only** (excludes the
+4,000 @ 0.625-gold line present on every player's market — that's premium currency,
not cash):

| Player | Units offered (cash) | Cash cost |
|---|---|---|
| India (day 2) | 1,905 | 20,907 |
| Russia (day 2) | 2,276 | 22,968 |
| Pakistan (day 3) | 2,627 | 33,765 |
| Japan (day 4) | 2,466 | 26,069 |
| South Africa (day 5) | 2,120 | 23,675 |
| 3 unattributed snapshots | 6,981 | 80,714 |
| **Total (8 snapshots)** | **18,375** | **208,098** |

Average ≈2,300 electronics per snapshot at 9–14 cash/unit, holding consistently across
all 8 identified/unattributed players checked. 18,375 electronics for ~208k cash
comfortably exceeds the ~5.6k–10.7k shortfall, using a small fraction of the
coalition's cash surplus (hundreds of thousands to low millions across the window).
Closes out the electronics-shortfall open item as resolvable via market purchase — no
further eco-side investment needed to cover it.
