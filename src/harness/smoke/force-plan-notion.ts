import { pool } from "../../db/pool.js";
import {
  findLatestFinishedForceRun,
  getForceRun,
  listForceRunCountryIds,
  readForceProjectionCountryData,
  type ForceRunSummary,
} from "../../db/force-run-reader.js";
import { buildForceProjectionCountryPage } from "../../notion/force-plan-blocks.js";
import { archivePage, createNotionPage, listChildPages } from "../../notion/notion-client.js";

/**
 * Unit 2's Notion render — a force_projection run straight from Postgres into
 * Notion pages, one per country, under a parent page. Pure render + publish: no
 * scenario/plan YAML, no engine, no re-simulation — everything comes from the
 * `run` this harness points at. Mirrors eco-plan-notion.ts exactly (a dedicated
 * script per unit, not folded into it — same convention).
 *
 * Reruns overwrite: before creating a country's page, any existing page(s) under
 * the parent with that exact title are archived first. Set
 * FORCE_RENDER_CLEAN_ONLY to archive matching pages without creating new ones.
 */

// ── Config ────────────────────────────────────────────────────────────────────

const scenarioId = process.env.FORCE_RENDER_SCENARIO ?? "elite/antarctica";
const planId = process.env.FORCE_RENDER_PLAN;
const runIdEnv = process.env.FORCE_RENDER_RUN;
const countryFilter = process.env.FORCE_RENDER_COUNTRY ?? "all";
const parentPageId = process.env.NOTION_PARENT_PAGE_ID;
const cleanOnly = ["1", "true"].includes((process.env.FORCE_RENDER_CLEAN_ONLY ?? "").toLowerCase());

if (!parentPageId) {
  throw new Error("NOTION_PARENT_PAGE_ID is not set — the parent page to create country reports under.");
}

// ── Run resolution ────────────────────────────────────────────────────────────

async function resolveRun(): Promise<ForceRunSummary> {
  if (runIdEnv) {
    const run = await getForceRun(parseInt(runIdEnv, 10));
    if (!run) throw new Error(`No force_projection run found with id ${runIdEnv}`);
    if (!run.finishedAt) {
      console.warn(`⚠ Run ${run.id} has no finished_at — it may have died part-way; rendering anyway.`);
    }
    return run;
  }
  const run = await findLatestFinishedForceRun({ scenarioId, planId });
  if (!run) {
    throw new Error(
      `No finished force_projection run found for scenario=${scenarioId}${planId ? ` plan=${planId}` : ""}. ` +
        `Run \`npm run smoke:force-plan-db\` first, or set FORCE_RENDER_RUN explicitly.`
    );
  }
  return run;
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  const run = await resolveRun();
  const countryIds = countryFilter === "all" ? await listForceRunCountryIds(run.id) : [countryFilter];

  console.log(
    `Rendering run ${run.id} (scenario ${run.scenarioId}${run.planId ? `, plan ${run.planId}` : ""}) — ` +
      `${countryIds.length} country(ies) -> Notion parent ${parentPageId}${cleanOnly ? " (clean-only)" : ""}`
  );

  const existingPages = await listChildPages(parentPageId);
  const existingByTitle = new Map<string, string[]>();
  for (const p of existingPages) {
    const ids = existingByTitle.get(p.title) ?? [];
    ids.push(p.id);
    existingByTitle.set(p.title, ids);
  }

  for (const countryId of countryIds) {
    const data = await readForceProjectionCountryData(run, countryId);
    if (!data) {
      console.warn(`  [${countryId}] not found in run ${run.id} — skipping`);
      continue;
    }

    const page = buildForceProjectionCountryPage(data);

    const stale = existingByTitle.get(page.title) ?? [];
    for (const pageId of stale) await archivePage(pageId);
    if (stale.length > 0) {
      console.log(`  [${countryId}] archived ${stale.length} existing page(s)`);
    }

    if (cleanOnly) continue;

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
