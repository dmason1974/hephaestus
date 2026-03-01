import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCountryFile } from "./validateCountryFile.js";

function projectRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "..");
}

const root = projectRoot();
const dir = path.join(root, "data", "countries");

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort();

if (files.length === 0) {
  console.error(`No country files found in ${dir}`);
  process.exit(2);
}

let ok = 0;
for (const f of files) {
  const full = path.join(dir, f);
  try {
    validateCountryFile(full);
    ok++;
  } catch (e) {
    console.error(`❌ ${f}\n${String(e)}\n`);
    process.exit(1);
  }
}

console.log(`✅ Validated ${ok} country file(s)`);