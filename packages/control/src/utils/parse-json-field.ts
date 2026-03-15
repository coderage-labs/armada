/**
 * Normalise a field that may arrive as a JSON string (from tool calls)
 * or as a native value (from UI / direct API calls).
 * Returns the parsed value, or the original if already the right type.
 */
export function parseJsonField<T = unknown>(value: T | string | undefined): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch (err: any) {
      console.warn('[parse-json-field] Failed to parse JSON field:', err.message);
      return value as unknown as T;
    }
  }
  return value;
}
