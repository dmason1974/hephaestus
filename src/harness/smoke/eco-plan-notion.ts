import { pool } from "../../db/pool.js";
import {
  findLatestFinishedEcoRun,
  getEcoRun,
  listEcoRunCountryIds,
  readEcoPlanCountryData,
  type EcoRunSummary,
} from "../../db/eco-run-reader.js";
import { buildEcoPlanCountryPage } from "../../notion/eco-plan-blocks.js";
import { createNotionPage } from "../../notion/notion-client.js";

/**
 * Unit 4 — renders a Unit 1 eco-plan run straight from Postgres into Notion
 * pages, one per country, under a parent page. Pure render + publish: no
 * scenario/country YAML, no engine, no re-simulation — everything comes from
 * the `run` this harness points at.
 */

// ── Config ────────────────────────────────────────────────────────────────────

const scenarioId = process.env.ECO_RENDER_SCENARIO ?? "elite/antarctica";
const planId = process.env.ECO_RENDER_PLAN;
const runIdEnv = process.env.ECO_RENDER_RUN;
const countryFilter = process.env.ECO_RENDER_COUNTRY ?? "all";
const parentPageId = process.env.NOTION_PARENT_PAGE_ID;

if (!parentPageId) {
  throw new Error("NOTION_PARENT_PAGE_ID is not set — the parent page to create country reports under.");
}

// ── Run resolution ────────────────────────────────────────────────────────────

async function resolveRun(): Promise<EcoRunSummary> {
  if (runIdEnv) {
    const run = await getEcoRun(parseInt(runIdEnv, 10));
    if (!run) throw new Error(`No eco_plan run found with id ${runIdEnv}`);
    if (!run.finishedAt) {
      console.warn(`⚠ Run ${run.id} has no finished_at — it may have died part-way; rendering anyway.`);
    }
    return run;
  }
  const run = await findLatestFinishedEcoRun({ scenarioId, planId });
  if (!run) {
    throw new Error(
      `No finished eco_plan run found for scenario=${scenarioId}${planId ? ` plan=${planId}` : ""}. ` +
        `Run \`npm run smoke:eco-plan\` first, or set ECO_RENDER_RUN explicitly.`
    );
  }
  return run;
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  const run = await resolveRun();
  const countryIds = countryFilter === "all" ? await listEcoRunCountryIds(run.id) : [countryFilter];

  console.log(
    `Rendering run ${run.id} (scenario ${run.scenarioId}${run.planId ? `, plan ${run.planId}` : ""}) — ` +
      `${countryIds.length} country(ies) -> Notion parent ${parentPageId}`
  );

  for (const countryId of countryIds) {
    const data = await readEcoPlanCountryData(run, countryId);
    if (!data) {
      console.warn(`  [${countryId}] not found in run ${run.id} — skipping`);
      continue;
    }

    const page = buildEcoPlanCountryPage(data);
    const created = await createNotionPage({
      parentPageId,
      title: page.title,
      icon: page.icon,
      blocks: page.blocks,
    });

    console.log(`  [${countryId}] → ${created.url}`);
  }

  console.log("Done.");
} catch (err) {
  console.error(
    "Failed. Is the SSH tunnel running (`npm run db:tunnel`), and are NOTION_API_KEY / NOTION_PARENT_PAGE_ID set?"
  );
  throw err;
} finally {
  await pool.end();
}
