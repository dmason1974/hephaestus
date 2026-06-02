#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: npm run plan <scenario>/<plan_id>");
  console.error("   or: npm run plan <plan_id>  (searches all scenarios)");
  console.error("");
  console.error("Examples:");
  console.error("  npm run plan ww3_2026/germany_mrl");
  console.error("  npm run plan germany_mrl");
  process.exit(1);
}

let scenarioId: string | null = null;
let planId: string;

// Check if format is scenario/plan_id
if (args[0].includes("/")) {
  const parts = args[0].split("/");
  scenarioId = parts[0];
  planId = parts[1];
} else {
  planId = args[0];
}

let planFilePath: string | null = null;

if (scenarioId) {
  // Direct path provided
  planFilePath = path.resolve(process.cwd(), "data/scenarios", scenarioId, "plans", `${planId}.yml`);
  if (!fs.existsSync(planFilePath)) {
    console.error(`Error: Plan file not found: ${planFilePath}`);
    process.exit(1);
  }
} else {
  // Search all scenarios
  const dataDir = path.resolve(process.cwd(), "data/scenarios");
  const scenarios = fs.readdirSync(dataDir).filter(name => {
    const stat = fs.statSync(path.join(dataDir, name));
    return stat.isDirectory();
  });

  for (const scenario of scenarios) {
    const candidatePath = path.join(dataDir, scenario, "plans", `${planId}.yml`);
    if (fs.existsSync(candidatePath)) {
      planFilePath = candidatePath;
      scenarioId = scenario;
      break;
    }
  }

  if (!planFilePath || !scenarioId) {
    console.error(`Error: Plan '${planId}' not found in any scenario.`);
    console.error(`Searched scenarios: ${scenarios.join(", ")}`);
    process.exit(1);
  }
}

// Read the plan file to get scenario info
const planContent = YAML.parse(fs.readFileSync(planFilePath, "utf8"));
const planName = planContent.name || planId;

// Ensure tmp directory exists
const tmpDir = path.resolve(process.cwd(), "tmp");
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// Set environment variables
process.env.PLAN_SCENARIO = scenarioId;
process.env.PLAN_ID = planId;
process.env.PLAN_OUTPUT = "html";
process.env.PLAN_OUTPUT_FILE = path.join(tmpDir, `${planId}-output.html`);

console.log(`Running force plan: ${planName}`);
console.log(`Scenario: ${scenarioId}`);
console.log(`Plan file: ${planFilePath}`);
console.log(`Output will be written to: ${process.env.PLAN_OUTPUT_FILE}`);
console.log("");

// Import and run the force-build-plan script
await import("../harness/smoke/force-build-plan.js");

// Made with Bob
