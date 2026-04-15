import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
} from "../../core/constants.js";
import { moraleOnDay, moraleProductionMultiplier } from "../../engine/economy/morale.js";

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumber(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const days = parsePositiveInt(process.env.MORALE_DAYS, 28);
const outputFilePath = path.resolve(process.env.MORALE_OUTPUT_FILE?.trim() || "tmp/occupied-city-morale-curve.html");
const moraleParams = {
  S: parseNumber(process.env.MORALE_S, STARTING_MORALE_DAY1),
  T: parseNumber(process.env.MORALE_T, HOMELAND_TARGET_MORALE),
  N: parseNumber(process.env.MORALE_N, 0),
  D: parseNumber(process.env.MORALE_D, DEFAULT_MORALE_DECAY_D),
};

const rows = Array.from({ length: days }, (_, index) => {
  const day = index + 1;
  const morale = moraleOnDay(day, moraleParams);
  return {
    day,
    morale,
    productionMultiplier: moraleProductionMultiplier(morale),
  };
});

const width = 960;
const height = 420;
const paddingLeft = 56;
const paddingRight = 24;
const paddingTop = 24;
const paddingBottom = 40;
const plotWidth = width - paddingLeft - paddingRight;
const plotHeight = height - paddingTop - paddingBottom;

function xForDay(day: number) {
  if (days <= 1) return paddingLeft;
  return paddingLeft + ((day - 1) / (days - 1)) * plotWidth;
}

function yForMorale(morale: number) {
  const minMorale = 0;
  const maxMorale = 100;
  return paddingTop + ((maxMorale - morale) / (maxMorale - minMorale)) * plotHeight;
}

const moralePath = rows
  .map((row, index) => `${index === 0 ? "M" : "L"} ${xForDay(row.day).toFixed(2)} ${yForMorale(row.morale).toFixed(2)}`)
  .join(" ");

const xTicks = Array.from({ length: Math.min(days, 8) }, (_, index) => {
  const tickDay = Math.round(1 + (index * (days - 1)) / Math.max(1, Math.min(days, 8) - 1));
  return { day: tickDay, x: xForDay(tickDay) };
});

const yTicks = [0, 20, 40, 60, 80, 100].map(value => ({
  value,
  y: yForMorale(value),
}));

const tableRows = rows.map(row =>
  `<tr><td>${row.day}</td><td>${row.morale}</td><td>${row.productionMultiplier.toFixed(2)}</td></tr>`
).join("");

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Occupied City Morale Curve</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.4; padding: 24px; max-width: 1100px; margin: 0 auto; }
    h1, h2 { margin: 20px 0 8px; }
    .note { color: #555; margin-bottom: 16px; }
    svg { width: 100%; height: auto; border: 1px solid #d0d7de; background: #fff; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border: 1px solid #d0d7de; padding: 8px 10px; text-align: left; }
    th { background: #f6f8fa; }
    .axis { stroke: #666; stroke-width: 1; }
    .grid { stroke: #e5e7eb; stroke-width: 1; }
    .curve { fill: none; stroke: #c2410c; stroke-width: 3; }
    .point { fill: #c2410c; }
    .label { font-size: 12px; fill: #374151; }
  </style>
</head>
<body>
  <h1>Occupied City Morale Curve</h1>
  <p class="note">
    This uses the repo's current morale function with params
    S=${escapeHtml(moraleParams.S)},
    T=${escapeHtml(moraleParams.T)},
    N=${escapeHtml(moraleParams.N)},
    D=${escapeHtml(moraleParams.D)}.
    In the current codebase, <code>cityStatus: "occupied"</code> does not by itself change the morale curve;
    occupation changes production through the city-status multiplier separately.
  </p>

  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Occupied city morale curve">
    ${yTicks.map(tick => `<line class="grid" x1="${paddingLeft}" y1="${tick.y}" x2="${width - paddingRight}" y2="${tick.y}"></line>`).join("")}
    ${xTicks.map(tick => `<line class="grid" x1="${tick.x}" y1="${paddingTop}" x2="${tick.x}" y2="${height - paddingBottom}"></line>`).join("")}
    <line class="axis" x1="${paddingLeft}" y1="${height - paddingBottom}" x2="${width - paddingRight}" y2="${height - paddingBottom}"></line>
    <line class="axis" x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${height - paddingBottom}"></line>
    ${yTicks.map(tick => `<text class="label" x="${paddingLeft - 10}" y="${tick.y + 4}" text-anchor="end">${tick.value}</text>`).join("")}
    ${xTicks.map(tick => `<text class="label" x="${tick.x}" y="${height - paddingBottom + 18}" text-anchor="middle">Day ${tick.day}</text>`).join("")}
    <path class="curve" d="${moralePath}"></path>
    ${rows.map(row => `<circle class="point" cx="${xForDay(row.day).toFixed(2)}" cy="${yForMorale(row.morale).toFixed(2)}" r="3"></circle>`).join("")}
  </svg>

  <h2>Values</h2>
  <table>
    <thead>
      <tr>
        <th>Day</th>
        <th>Morale</th>
        <th>Production Multiplier</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>
</body>
</html>`;

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, html, "utf8");

console.log("Occupied city morale curve");
console.log("Note: in the current code, occupied status does not alter morale params by itself.");
console.table(rows);
console.error(`[morale-curve] html written to ${outputFilePath}`);
