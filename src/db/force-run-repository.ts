import type { CountryForceProjectionResult } from "../engine/optimization/country-force-projection.js";
import type { ResourceCost } from "../engine/optimization/types.js";
import { pool } from "./pool.js";
import { insertRunCity, type RunCityMeta } from "./eco-run-repository.js";
import { insertResourceFlow, resourceValues } from "./resource-flow.js";

export type CountryForceWriteInput = {
  runId: number;
  countryId: string;
  countryName: string;
  doctrine: string;
  status: "homeland" | "occupied";
  captureDay?: number;
  /** Converts provinceMobResults' relative-to-scenario-start hours (see
   *  planProvinceMobilization's own doc comments) to the same absolute-hour
   *  frame every other persisted table already uses (research segments, city
   *  infra/mob steps) — keeps force_province_mob_result's stored hours
   *  directly comparable/renderable the same way, with no per-consumer
   *  conversion needed. */
  scenarioAbsHour: number;
  forceProjection: CountryForceProjectionResult;
  /** Name/resource/capital for every city with an assigned demand, keyed by bare
   *  cityId — sourced by the harness from the country YAML (country.cities).
   *  Cities with no demand aren't persisted at all — this is the plain force
   *  projection only, not an eco build (no beam search, no per-city eco data). */
  cityMeta: Map<string, RunCityMeta>;
};

/**
 * Persists one country's plain force projection (computeCountryForceProjection,
 * unmodified — no eco credit, no beam search, infra chains built from scratch,
 * same computation iron-fp-plan.ts already runs) — country-level result, each
 * assigned city's flip point / infra chain / mob queue, research segments,
 * province mobilisation, deadline-overrun demands, and cost totals, in a single
 * transaction, so a country is either wholly present or wholly absent. Mirrors
 * writeCountryEcoResult's transaction shape.
 */
export async function writeCountryForceResult(input: CountryForceWriteInput): Promise<void> {
  const { runId, scenarioAbsHour, forceProjection: fp } = input;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: countryRows } = await client.query<{ id: string }>(
      `INSERT INTO run_country (run_id, country_id, country_name, doctrine, status, capture_day)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [runId, input.countryId, input.countryName, input.doctrine, input.status, input.captureDay ?? null]
    );
    const runCountryId = Number(countryRows[0].id);

    await client.query(
      `INSERT INTO force_country_result
         (run_country_id, morale_at_start, morale_at_deadline, infeasible, reason,
          demand_labels, skipped_demands, missing_data_demands, plan_weights)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        runCountryId, fp.moraleAtStart, fp.moraleAtDeadline, fp.infeasible, fp.reason ?? null,
        JSON.stringify(fp.demandLabels), JSON.stringify(fp.skippedDemands),
        JSON.stringify(fp.missingDataDemands), JSON.stringify(fp.planWeights),
      ]
    );

    for (const slot of fp.citySlots) {
      const meta = input.cityMeta.get(slot.cityId);
      if (!meta) throw new Error(`No cityMeta for ${slot.cityId} (country ${input.countryId})`);

      const runCityId = await insertRunCity(client, runCountryId, meta);

      await client.query(
        `INSERT INTO force_city_slot
           (run_city_id, ro_level, primary_unit_id, infra_open_hour, flip_point_abs_hour, mob_queue)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [runCityId, slot.roLevel, slot.primaryUnitId, slot.infraOpenHour, slot.flipPointAbsHour, JSON.stringify(slot.mobQueue)]
      );

      // ecoBackfillSteps is always empty here — computeCountryForceProjection has
      // no eco result to backfill from without actualEcoResultsByCity (see its own
      // type doc). Only ever writes kind='infra' rows; the column stays 'infra'-only
      // by construction, not by a narrower schema.
      for (const [kind, steps] of [["eco_backfill", slot.ecoBackfillSteps], ["infra", slot.infraSteps]] as const) {
        for (const [i, step] of steps.entries()) {
          await client.query(
            `INSERT INTO force_infra_step
               (run_city_id, kind, step_no, name, building_id, from_level, to_level,
                start_hour, end_hour, dur_h, supplies, components, fuel, rares, electronics, cash, manpower)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [
              runCityId, kind, i + 1, step.name, step.buildingId, step.fromLevel, step.toLevel,
              step.startHour, step.endHour, step.durH, ...resourceValues(step.cost),
            ]
          );
        }
      }

      // A unit's mobilisation can now span multiple rows here (research-level
      // phase splits — see splitMobBatchByLevel), not just unit_limit tranches;
      // step_no is a plain per-city ordinal, so this loop handles that unchanged.
      for (const [i, m] of slot.mobSteps.entries()) {
        await client.query(
          `INSERT INTO force_mob_step
             (run_city_id, step_no, unit_id, count, level, start_abs_hour, end_abs_hour, duration_hours)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [runCityId, i + 1, m.unitId, m.count, m.level ?? null, m.startAbsHour, m.endAbsHour, m.durationHours]
        );
      }
    }

    for (const [i, seg] of fp.researchSegments.entries()) {
      await client.query(
        `INSERT INTO force_research_segment
           (run_country_id, step_no, slot, unit_id, level, unlock_day, start_abs_hour,
            end_abs_hour_exclusive, duration_hours, supplies, components, fuel, rares, electronics, cash, manpower)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          runCountryId, i + 1, seg.slot, seg.unitId, seg.level, seg.unlockDay, seg.startAbsoluteHour,
          seg.endAbsoluteHourExclusive, seg.durationHours, ...resourceValues(seg.cost),
        ]
      );
    }

    for (const [i, r] of fp.provinceMobResults.entries()) {
      // planProvinceMobilization's hours are all relative-to-scenario-start
      // (see its own doc comments) — convert to the same absolute-hour frame
      // research segments and city infra/mob steps already use, so a
      // consumer never has to know province timing is a special case.
      const absTranches = r.tranches.map(t => ({
        ...t,
        mercenaryOutpostStartHour: scenarioAbsHour + t.mercenaryOutpostStartHour,
        mercenaryOutpostCompleteHour: scenarioAbsHour + t.mercenaryOutpostCompleteHour,
        mobilisationEarliestHour: scenarioAbsHour + t.mobilisationEarliestHour,
        mobStartHour: scenarioAbsHour + t.mobStartHour,
        completionHour: scenarioAbsHour + t.completionHour,
      }));
      await client.query(
        `INSERT INTO force_province_mob_result
           (run_country_id, step_no, unit_id, level, count, province_count,
            mercenary_outpost_required_level, mercenary_outpost_build_hours,
            mob_start_hour, completion_hour, mobilization_duration_hours, tranches,
            mercenary_outpost_build_cost_supplies, mercenary_outpost_build_cost_components,
            mercenary_outpost_build_cost_fuel, mercenary_outpost_build_cost_rares,
            mercenary_outpost_build_cost_electronics, mercenary_outpost_build_cost_cash,
            mercenary_outpost_build_cost_manpower,
            mobilization_cost_supplies, mobilization_cost_components, mobilization_cost_fuel,
            mobilization_cost_rares, mobilization_cost_electronics, mobilization_cost_cash,
            mobilization_cost_manpower)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [
          runCountryId, i + 1, r.unitId, r.level, r.count, r.provinceCount,
          r.mercenaryOutpostRequiredLevel, r.mercenaryOutpostBuildHours,
          scenarioAbsHour + r.mobStartHour, scenarioAbsHour + r.completionHour, r.mobilizationDurationHours, JSON.stringify(absTranches),
          ...resourceValues(r.mercenaryOutpostBuildCost), ...resourceValues(r.mobilizationCost),
        ]
      );
    }

    // A mob step whose real, research-level-split mobEnd lands after the truce
    // deadline — the actual explanation for `infeasible` when it's not one of
    // the two coarse `reason` values. See force_overrun_demand's own comment.
    for (const [i, d] of fp.overrunDemands.entries()) {
      await client.query(
        `INSERT INTO force_overrun_demand
           (run_country_id, step_no, unit_id, city_id, level, mob_end_abs_hour, deadline_abs_hour)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [runCountryId, i + 1, d.unitId, d.cityId, d.level, d.mobEnd, d.deadlineAbsHour]
      );
    }

    const costBuckets: Array<[string, ResourceCost]> = [
      ["infra_ro", fp.costs.infraRo],
      ["infra_buildings", fp.costs.infraBuildings],
      ["mobilisation", fp.costs.mobilisation],
      ["upkeep", fp.costs.upkeep],
      ["province_mobilisation", fp.costs.provinceMobilisation],
      ["province_upkeep", fp.costs.provinceUpkeep],
      ["total", fp.costs.total],
    ];
    for (const [category, cost] of costBuckets) {
      await insertResourceFlow(client, runId, "country", runCountryId, category, cost);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`Failed to persist force projection for ${input.countryId}`, { cause: err });
  } finally {
    client.release();
  }
}
