import type { ValidationError } from "@topik/core";

export function formatValidationFailure(
  errors: ValidationError[],
  resourceCount: number,
  context: string,
): string {
  const lines = errors.map((error) => `${error.resource}: ${error.path} ${error.message}`);
  lines.push("");
  lines.push(`${errors.length} validation error(s) in ${resourceCount} resources while ${context}`);
  return lines.join("\n");
}
