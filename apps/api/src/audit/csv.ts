/** A leading character a spreadsheet would evaluate as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * One RFC 4180 field. Objects become JSON; a cell that would start a formula
 * gets a leading `'` (spec D12) — JSON columns start with `{`, `[` or `"` and
 * are never touched.
 */
export const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const csvRow = (values: readonly unknown[]): string =>
  `${values.map(csvCell).join(',')}\r\n`;
