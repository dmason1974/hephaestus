import { z } from "zod";

export const enumerationsFileSchema = z.object({
  resources: z.array(z.string()).min(1),
  doctrines: z.array(z.string()).min(1),
});

export type Enumerations = z.infer<typeof enumerationsFileSchema>;

export function parseEnumerations(input: unknown, source = "enumerations input"): Enumerations {
  const result = enumerationsFileSchema.safeParse(input);

  if (!result.success) {
    throw new Error(`Invalid enumerations data (${source}):\n${result.error.toString()}`);
  }

  return {
    resources: result.data.resources.map(entry => entry.trim().toLowerCase()),
    doctrines: result.data.doctrines.map(entry => entry.trim().toLowerCase()),
  };
}
