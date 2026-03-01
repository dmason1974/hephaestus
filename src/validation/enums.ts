import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { fileURLToPath } from "node:url";

const EnumerationsFileSchema = z.object({
  resources: z.array(z.string()).min(1),
  doctrines: z.array(z.string()).min(1),
});

export type Enumerations = z.infer<typeof EnumerationsFileSchema>;

export function loadEnumerations(enumsPath: string): Enumerations {
  const raw = fs.readFileSync(enumsPath, "utf8");
  const parsed = YAML.parse(raw);

  const result = EnumerationsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid enums.yml at ${enumsPath}:\n${result.error.toString()}`
    );
  }

  return {
    resources: result.data.resources.map((s) => s.trim().toLowerCase()),
    doctrines: result.data.doctrines.map((s) => s.trim().toLowerCase()),
  };
}

export function projectRoot(): string {
  // __dirname equivalent in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // enums.ts lives in src/validation, so go up two levels to repo root
  return path.resolve(__dirname, "..", "..");
}