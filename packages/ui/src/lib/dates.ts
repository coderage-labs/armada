/**
 * Parse a date string safely — handles SQLite datetime format
 * which uses space separator instead of ISO 8601's 'T'.
 */
export function parseDate(dateStr: string | null | undefined): Date {
  if (!dateStr) return new Date(NaN);
  // SQLite: "2026-03-11 10:05:20" → needs T separator for cross-browser compat
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  return new Date(normalized);
}

/**
 * Format a date string for display.
 */
export function formatDate(dateStr: string | null | undefined): string {
  const d = parseDate(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

export function formatDateTime(dateStr: string | null | undefined): string {
  const d = parseDate(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}
