/**
 * Simple mustache-style variable interpolation.
 * Replaces {{key}} with the corresponding value from vars.
 * Unknown variables are left as-is.
 */
export function resolveVariables(
  text: string,
  vars: Record<string, string>,
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

/**
 * Deep-resolve variables in an object (recursively handles strings in objects/arrays).
 */
export function resolveDeep<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') {
    return resolveVariables(value, vars) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveDeep(item, vars)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveDeep(v, vars);
    }
    return result as T;
  }
  return value;
}
