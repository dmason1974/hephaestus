# Force Projection Plan

## Summary

| scenario | country | windowDays | planId | planName | searchSpace | affordableBaseline | affordableWithEcoSupport |
| --- | --- | --- | --- | --- | --- | --- | --- |
| elite_ww3_map_feb_2026 (4x1.4) | Indonesia | 28 | indonesia_air_navy_28d | Indonesia Air and Navy 28d | 20 | yes |  |

## Demand

| unitId | count |
| --- | --- |
| frigate | 40 |

## Chosen Footprint

| queueType | queueKey | cityCount | requiredBaseLevel | requiredArmyBaseLevel | requiredRecruitingOfficeLevel | perCityQueueHours |
| --- | --- | --- | --- | --- | --- | --- |
| naval | naval:frigate | 4 | 2 | 0 | 0 | 240, 240, 240, 240 |

## Cost Summary

| totalEconomicCost | infraSupplies | infraComponents | infraFuel | infraRares | infraElectronics | infraCash | infraManpower | upkeepSupplies | upkeepComponents | upkeepFuel | upkeepRares | upkeepElectronics | upkeepCash | upkeepManpower | readyHoursBeforeWar |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 83300 | 3600 | 4400 | 4400 | 900 | 3000 | 13000 | 0 | 0 | 16200 | 8100 | 0 | 0 | 21600 | 8100 | 4320 |

## Baseline Affordability

- Affordable against starting balance plus baseline country income.

| supplies | components | fuel | rares | electronics | cash | manpower |
| --- | --- | --- | --- | --- | --- | --- |
| 40000 | 30000 | 15000 | 10000 | 10000 | 150000 | 15000 |

## Research Plan

### Slot 1
| unitId | level | startDay | startHour | endDay | endHour | durationHours |
| --- | --- | --- | --- | --- | --- | --- |
| frigate | 1 | 18 | 18 | 19 | 15 | 21 |
| frigate | 2 | 26 | 12 | 27 | 11 | 23 |
| frigate | 3 | 27 | 11 | 28 | 11 | 24 |
| frigate | 4 | 28 | 11 | 29 | 15 | 28 |

### Slot 2
_None_

## City Plans

### NAVAL Cities
| slot | cityId | name | resource | capital | population | buildSteps | firstMobilizeDay | firstMobilizeHour |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | medan | Medan | electronics | no | 5 | arms_industry -> level 1 ; naval_base -> level 2 | 19 | 15 |
| 2 | makassar | Makassar | components | no | 5 | arms_industry -> level 1 ; naval_base -> level 2 | 19 | 15 |
| 3 | jakarta | Jakarta | supplies | yes | 6 | arms_industry -> level 1 ; naval_base -> level 2 | 19 | 15 |
| 4 | padang | Padang | supplies | no | 5 | arms_industry -> level 1 ; naval_base -> level 2 | 19 | 15 |

#### Medan
| buildingId | fromLevel | toLevel | startRelHour | startDay | startHour | completionDay | completionHour | durationHours |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arms_industry | 0 | 1 | 0 | 1 | 15 | 2 | 0.75 | 9.75 |
| naval_base | 1 | 2 | 9.75 | 2 | 0.75 | 2 | 10.42 | 9.67 |

#### Makassar
| buildingId | fromLevel | toLevel | startRelHour | startDay | startHour | completionDay | completionHour | durationHours |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arms_industry | 0 | 1 | 0 | 1 | 15 | 2 | 0.75 | 9.75 |
| naval_base | 1 | 2 | 9.75 | 2 | 0.75 | 2 | 10.42 | 9.67 |

#### Jakarta
| buildingId | fromLevel | toLevel | startRelHour | startDay | startHour | completionDay | completionHour | durationHours |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arms_industry | 0 | 1 | 0 | 1 | 15 | 2 | 0.75 | 9.75 |
| naval_base | 1 | 2 | 9.75 | 2 | 0.75 | 2 | 10.42 | 9.67 |

#### Padang
| buildingId | fromLevel | toLevel | startRelHour | startDay | startHour | completionDay | completionHour | durationHours |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arms_industry | 0 | 1 | 0 | 1 | 15 | 2 | 0.75 | 9.75 |
| naval_base | 1 | 2 | 9.75 | 2 | 0.75 | 2 | 10.42 | 9.67 |

## Mobilisation Timeline

| queueType | queueKey | cityIndex | unitId | mobilizeLevel | recruitingOfficeLevel | startDay | startHour | endDay | endHour | durationHours |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| naval | naval:frigate | 1 | frigate | 1 | 0 | 19 | 15 | 20 | 15 | 24 |
| naval | naval:frigate | 2 | frigate | 1 | 0 | 19 | 15 | 20 | 15 | 24 |
| naval | naval:frigate | 3 | frigate | 1 | 0 | 19 | 15 | 20 | 15 | 24 |
| naval | naval:frigate | 4 | frigate | 1 | 0 | 19 | 15 | 20 | 15 | 24 |
| naval | naval:frigate | 1 | frigate | 1 | 0 | 20 | 15 | 21 | 15 | 24 |
| naval | naval:frigate | 2 | frigate | 1 | 0 | 20 | 15 | 21 | 15 | 24 |
| naval | naval:frigate | 3 | frigate | 1 | 0 | 20 | 15 | 21 | 15 | 24 |
| naval | naval:frigate | 4 | frigate | 1 | 0 | 20 | 15 | 21 | 15 | 24 |
| naval | naval:frigate | 1 | frigate | 1 | 0 | 21 | 15 | 22 | 15 | 24 |
| naval | naval:frigate | 2 | frigate | 1 | 0 | 21 | 15 | 22 | 15 | 24 |
| naval | naval:frigate | 3 | frigate | 1 | 0 | 21 | 15 | 22 | 15 | 24 |
| naval | naval:frigate | 4 | frigate | 1 | 0 | 21 | 15 | 22 | 15 | 24 |
| naval | naval:frigate | 1 | frigate | 1 | 0 | 22 | 15 | 23 | 15 | 24 |
| naval | naval:frigate | 2 | frigate | 1 | 0 | 22 | 15 | 23 | 15 | 24 |
| naval | naval:frigate | 3 | frigate | 1 | 0 | 22 | 15 | 23 | 15 | 24 |
| naval | naval:frigate | 4 | frigate | 1 | 0 | 22 | 15 | 23 | 15 | 24 |
| naval | naval:frigate | 1 | frigate | 1 | 0 | 23 | 15 | 24 | 15 | 24 |
| naval | naval:frigate | 2 | frigate | 1 | 0 | 23 | 15 | 24 | 15 | 24 |
| naval | naval:frigate | 3 | frigate | 1 | 0 | 23 | 15 | 24 | 15 | 24 |
| naval | naval:frigate | 4 | frigate | 1 | 0 | 23 | 15 | 24 | 15 | 24 |
| naval | naval:frigate | 1 | frigate | 1 | 0 | 24 | 15 | 25 | 15 | 24 |
| naval | naval:frigate | 2 | frigate | 1 | 0 | 24 | 15 | 25 | 15 | 24 |
| naval | naval:frigate | 3 | frigate | 1 | 0 | 24 | 15 | 25 | 15 | 24 |
| naval | naval:frigate | 4 | frigate | 1 | 0 | 24 | 15 | 25 | 15 | 24 |
| naval | naval:frigate | 1 | frigate | 1 | 0 | 25 | 15 | 26 | 15 | 24 |
| naval | naval:frigate | 2 | frigate | 1 | 0 | 25 | 15 | 26 | 15 | 24 |
| naval | naval:frigate | 3 | frigate | 1 | 0 | 25 | 15 | 26 | 15 | 24 |
| naval | naval:frigate | 4 | frigate | 1 | 0 | 25 | 15 | 26 | 15 | 24 |
| naval | naval:frigate | 1 | frigate | 1 | 0 | 26 | 15 | 27 | 15 | 24 |
| naval | naval:frigate | 2 | frigate | 1 | 0 | 26 | 15 | 27 | 15 | 24 |
| naval | naval:frigate | 3 | frigate | 1 | 0 | 26 | 15 | 27 | 15 | 24 |
| naval | naval:frigate | 4 | frigate | 1 | 0 | 26 | 15 | 27 | 15 | 24 |
| naval | naval:frigate | 1 | frigate | 1 | 0 | 27 | 15 | 28 | 15 | 24 |
| naval | naval:frigate | 2 | frigate | 1 | 0 | 27 | 15 | 28 | 15 | 24 |
| naval | naval:frigate | 3 | frigate | 1 | 0 | 27 | 15 | 28 | 15 | 24 |
| naval | naval:frigate | 4 | frigate | 1 | 0 | 27 | 15 | 28 | 15 | 24 |
| naval | naval:frigate | 1 | frigate | 1 | 0 | 28 | 15 | 29 | 15 | 24 |
| naval | naval:frigate | 2 | frigate | 1 | 0 | 28 | 15 | 29 | 15 | 24 |
| naval | naval:frigate | 3 | frigate | 1 | 0 | 28 | 15 | 29 | 15 | 24 |
| naval | naval:frigate | 4 | frigate | 1 | 0 | 28 | 15 | 29 | 15 | 24 |
