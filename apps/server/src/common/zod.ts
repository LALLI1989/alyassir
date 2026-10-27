import type { ZodType, ZodTypeDef } from "zod";
import { ApiException } from "./errors";

/** Validates input with a shared schema. Field errors are translation keys. */
export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join(".") || "_";
    fields[path] ??= issue.message.includes(" ") ? "invalid" : issue.message;
  }
  throw new ApiException("VALIDATION", { fields });
}
