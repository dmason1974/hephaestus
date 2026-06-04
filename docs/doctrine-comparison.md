# Doctrine Comparison Reference

Source: Twin Harbour doctrine chart (circa 2017-10-26). TH has made balance tweaks since — treat these as indicative, not authoritative. Always verify against in-game screenshots.

**European doctrine is the baseline** (zero modifier). Western and Eastern unlock day deltas are shown relative to European.

Combat bonuses (damage, HP, speed) are noted but **not currently modelled** in the engine.

---

## Notation

`RESEARCH UNLOCK DAY/LEVEL` rows show the per-level delta applied to a doctrine's unlock days relative to the European baseline. Negative = unlocks earlier, positive = unlocks later.

---

## Infantry & Armour

| Unit | Western | European | Eastern |
|------|---------|----------|---------|
| Motorized Infantry | 0 > 0 > 0 > +1 > +1 > +2 > +2 | — (baseline) | 0 > 0 > -1 > -1 > -2 > -2 > -2 |
| Mechanized Infantry | +1 > +1 > +2 > +2 > +2 > +2 | Infantry Dmg +25%, Speed +10% | +1 > +1 > +2 > +2 > +2 > +2 |
| Naval Infantry | HP +15%, Speed +10% | — | — |
| Airborne Infantry | 0 > -1 > -2 > -2 > -2 > -2 > -2 | — | 0 > +2 > +2 > +2 > +2 > +2 > +3 |
| Special Forces | +1 > +1 > +2 > +2 > +3 | — | Infantry Dmg +10%; -1 > -1 > -2 > -2 > -3 |
| Armored Combat Vehicle | HP +3; -2 > -2 > -2 > -4 > -4 > -6 > -6 | — | -1 > -1 > -1 > -2 > -2 > -3 > -3 |
| Main Battle Tank | HP +10%; +1 > +1 > +1 > +2 > +2 > +2 > +3 | Infantry Dmg +10% | Armoured Dmg +5%, Speed +10%; -1 > -1 > -2 > -2 > -2 > -2 > -2 |
| Tank Destroyers | +1 > +1 > +2 > +2 > +2 > +3 | Armoured Dmg +5%, HP +3 | +2 > +2 > +2 > +4 > +4 > +4 > +5 |

---

## Air & Artillery

| Unit | Western | European | Eastern |
|------|---------|----------|---------|
| Towered Artillery | — | — | 0 > 0 > -1 > -1 > -1 > -2 > -2 |
| Mobile Artillery | 0 > +1 > +1 > +2 > +2 > +2 | Infantry Dmg +5%, HP +20% | -1 > -1 > -1 > -2 > -2 > -2 |
| Mobile Anti-Air Vehicle | — | Helicopter Dmg +20% | — |
| SAM | — | — | Aircraft Dmg +20%; -1 > -1 > -2 > -2 > -2 > -3 |
| TDS | -1 > -1 > -1 > -2 > 0 > -3 | — | +1 > +2 > +2 > +2 > 0 > 0 |
| Gunship Helicopter | — | — | -1 > -1 > -1 > -2 > -2 > -2 > -2 |
| Attack Helicopter | Armoured Dmg +20%; -2 > -2 > -4 > -4 > -4 > -4 | — | — |
| Air Superiority Fighter | Aircraft Dmg +10%, Heli Dmg +10%; 0 > 0 > -2 > -2 > -2 > -2 > -2 | — (baseline) | 0 > 0 > +2 > +2 > +2 > +2 > +2 |
| Strike Fighter | +2 > +2 > +2 > +4 > +4 > +4 > +4 | HP +20% | +1 > +1 > +1 > +2 > +2 > +2 > -2 |
| AWACS | -2 > -2 > -2 > -2 > -2 > -3 | — | — |
| Heavy Bombers | Infantry Dmg +20%, HP +3 | — | +1 > +1 > +1 > +2 > +2 > +3 > +3 |

---

## Officers

| Unit | Western | European | Eastern |
|------|---------|----------|---------|
| Infantry Officer | 0 > +1 > +1 > +2 > +3 > +3 > +2 | — | 0 > 0 > 0 > 0 > 0 > -1 > -2 |
| Airborne Officer | -2 > -2 > -1 > -2 > -2 > -1 > -2 | — | +1 > 0 > 0 > -1 > -1 > -1 > -1 |
| Tank Commander | +1 > 0 > -2 > -3 > -3 > -3 > -3 | — | -1 > -1 > -2 > -3 > -2 > 0 > 0 |
| Rotary Wing Officer | -1 > 0 > 0 > +1 > +1 > +1 > +2 | — | — |
| Fixed Wing Officer | +2 > +1 > +1 > -2 > -2 > -2 > -2 | — | +1 > +1 > +1 > 0 > +1 > +1 > +2 |
| Naval Officer | 0 > +1 > +1 > 0 > +2 > +1 > 0 | — | 0 > 0 > 0 > 0 > +1 > +2 > 0 |

---

## Notes

- Eastern doctrine data is noted here for completeness but is **not in scope** for current data entry work.
- Where a doctrine shows only a combat bonus and no unlock day delta, its unlock days match European baseline.
- Units with a blank cell for a doctrine are either western/eastern-exclusive or European-exclusive.
